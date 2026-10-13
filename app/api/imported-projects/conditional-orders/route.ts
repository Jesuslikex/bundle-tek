import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { UUID } from '@/lib/wallet-operation';
import {
  conditionalOrderTerms,
  decodeConditionalOrder,
  type ConditionalOrder,
} from '@/lib/conditional-order';
import {
  requireConditionalBuyStorage,
  ConditionalBuyStorageUnavailable,
} from '@/lib/conditional-buy-capability';
import { reviewMarketTrigger } from '@/lib/market-trigger';
import type { SavedTokenMarket } from '@/lib/token-market';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
type Row = {
  id: string;
  document: string;
  state: 'draft' | 'cancelled';
  revision: number;
  createdAt: string;
  updatedAt: string;
};
const columns =
  'id,document,state,revision,created_at AS createdAt,updated_at AS updatedAt';
const order = (row: Row): ConditionalOrder =>
  decodeConditionalOrder({
    id: row.id,
    terms: JSON.parse(row.document),
    state: row.state,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
function id(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error();
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) >= 1e9)
    throw new Error();
  return Number(value);
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to read conditional orders.' }, 401);
  let projectId: string;
  try {
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].join(',') !== 'projectId') throw new Error();
    projectId = id(query.get('projectId'));
  } catch {
    return json({ error: 'Choose an imported project.' }, 400);
  }
  try {
    const db = getD1();
    const results = await db.batch([
      db
        .prepare(
          'SELECT id FROM imported_token_projects WHERE owner_id=? AND id=?',
        )
        .bind(user.userId, projectId),
      db
        .prepare(
          `SELECT ${columns} FROM conditional_sell_orders WHERE owner_id=? AND project_id=? ORDER BY created_at DESC,id LIMIT 101`,
        )
        .bind(user.userId, projectId),
    ]);
    if (!results[0].results.length)
      return json({ error: 'Imported project unavailable.' }, 404);
    if (results[1].results.length > 100) throw new Error();
    const levels = await db
      .prepare(`SELECT v.order_id AS orderId,v.level,v.intent_id AS intentId,v.units_raw AS unitsRaw,i.state,i.signature,NULL AS receiptId FROM conditional_level_reservations v JOIN conditional_sell_orders o ON o.owner_id=v.owner_id AND o.id=v.order_id JOIN imported_swap_signing_intents i ON i.owner_id=v.owner_id AND i.id=v.intent_id WHERE v.owner_id=? AND o.project_id=?
      UNION ALL SELECT f.order_id AS orderId,f.level,f.intent_id AS intentId,f.units_raw AS unitsRaw,'filled' AS state,f.signature,f.receipt_id AS receiptId FROM conditional_level_fills f JOIN conditional_sell_orders o ON o.owner_id=f.owner_id AND o.id=f.order_id WHERE f.owner_id=? AND o.project_id=? LIMIT 5001`)
      .bind(user.userId, projectId, user.userId, projectId)
      .all();
    if (levels.results.length > 5000) throw new Error();
    return json({
      projectId,
      orders: (results[1].results as unknown as Row[]).map(order),
      levels: levels.results,
      executionAllowed: false,
    });
  } catch {
    return json({ error: 'Conditional order storage unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to manage conditional orders.' }, 401);
  let body: Record<string, unknown>, projectId: string, orderId: string;
  try {
    if (
      !request.headers
        .get('content-type')
        ?.toLowerCase()
        .startsWith('application/json')
    )
      throw new Error();
    body = await walletRequest(request, 3000);
    projectId = id(body.projectId);
    orderId = id(body.orderId);
    if (!['create', 'cancel', 'review'].includes(String(body.action)))
      throw new Error();
    const allowed =
      body.action === 'create'
        ? body.kind === 'grid'
          ? 'action,amount,direction,kind,lines,maximumUsd,minimumUsd,orderId,pair,projectId,projectRevision,wallet,walletRevision'
          : 'action,amount,direction,kind,orderId,pair,projectId,projectRevision,targetUsd,wallet,walletRevision'
        : 'action,orderId,projectId,revision';
    const expected =
      body.action === 'create' && body.side !== undefined
        ? allowed.split(',').concat('side').sort().join(',')
        : allowed;
    if (
      Object.keys(body).sort().join(',') !== expected ||
      (body.side !== undefined && body.side !== 'Buy' && body.side !== 'Sell')
    )
      throw new Error();
    if (body.action !== 'create') revision(body.revision);
  } catch {
    return json({ error: 'Review valid conditional order inputs.' }, 400);
  }
  try {
    const db = getD1(),
      owner = user.userId;
    const read = () =>
      db
        .prepare(
          `SELECT ${columns} FROM conditional_sell_orders WHERE owner_id=? AND project_id=? AND id=?`,
        )
        .bind(owner, projectId, orderId)
        .first<Row>();
    const existing = await read();
    if (body.action === 'create') {
      if (body.side === 'Buy') await requireConditionalBuyStorage(db);
      const project = await db
        .prepare(
          'SELECT chain,address,revision,archived,document FROM imported_token_projects WHERE owner_id=? AND id=?',
        )
        .bind(owner, projectId)
        .first<{
          chain: string;
          address: string;
          revision: number;
          archived: number;
          document: string;
        }>();
      if (!project)
        return json({ error: 'Imported project unavailable.' }, 404);
      if (project.archived || project.revision !== body.projectRevision)
        return json(
          { error: 'Project changed or is archived. Reload projects.' },
          409,
        );
      let terms: ConditionalOrder['terms'];
      try {
        const token = JSON.parse(project.document).token;
        if (token.chain !== project.chain || token.address !== project.address)
          throw new Error();
        terms = conditionalOrderTerms(body, token);
      } catch {
        return json(
          {
            error:
              'Choose valid exact amounts, levels and current Solana wallet.',
          },
          400,
        );
      }
      const document = JSON.stringify(terms);
      if (existing)
        return existing.document === document
          ? json({ order: order(existing), executionAllowed: false })
          : json(
              {
                error:
                  'This request ID already belongs to different order terms.',
              },
              409,
            );
      const now = new Date().toISOString();
      await db
        .prepare(`INSERT INTO conditional_sell_orders(owner_id,id,project_id,document,state,revision,created_at,updated_at)
        SELECT ?,?,?,?,'draft',1,?,? WHERE EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND archived=0 AND document=?)
        AND EXISTS(SELECT 1 FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND revision=? AND archived=0)
        AND (SELECT COUNT(*) FROM conditional_sell_orders WHERE owner_id=? AND project_id=?)<100
        ON CONFLICT(owner_id,id) DO NOTHING`)
        .bind(
          owner,
          orderId,
          projectId,
          document,
          now,
          now,
          owner,
          projectId,
          terms.projectRevision,
          project.document,
          owner,
          terms.wallet,
          terms.walletRevision,
          owner,
          projectId,
        )
        .run();
      const saved = await read();
      if (!saved || saved.document !== document)
        return json(
          {
            error:
              'Project or wallet changed, order capacity reached, or request ID conflicted. Reload before saving.',
          },
          409,
        );
      return json({ order: order(saved), executionAllowed: false });
    }
    if (!existing)
      return json({ error: 'Conditional order unavailable.' }, 404);
    if (body.action === 'cancel') {
      if (
        existing.state === 'cancelled' &&
        existing.revision === Number(body.revision) + 1
      )
        return json({ order: order(existing), executionAllowed: false });
      if (existing.revision !== body.revision || existing.state !== 'draft')
        return json({ error: 'Order changed. Reload saved orders.' }, 409);
      const result = await db
        .prepare(
          "UPDATE conditional_sell_orders SET state='cancelled',revision=revision+1,updated_at=? WHERE owner_id=? AND project_id=? AND id=? AND revision=? AND state='draft' AND NOT EXISTS(SELECT 1 FROM conditional_level_reservations v WHERE v.owner_id=conditional_sell_orders.owner_id AND v.order_id=conditional_sell_orders.id)",
        )
        .bind(
          new Date().toISOString(),
          owner,
          projectId,
          orderId,
          body.revision,
        )
        .run();
      if (!result.meta.changes)
        return json(
          {
            error:
              'Order changed or has an active approval. Recover that approval before cancelling the draft.',
          },
          409,
        );
      return json({ order: order((await read())!), executionAllowed: false });
    }
    if (existing.state !== 'draft' || existing.revision !== body.revision)
      return json({ error: 'Order changed or was cancelled.' }, 409);
    const terms = order(existing).terms;
    if (terms.format === 'conditional-buy-v1')
      await requireConditionalBuyStorage(db);
    const context = await db
      .prepare(`SELECT p.revision,p.archived,p.chain,p.address,m.document AS market,w.revision AS walletRevision,w.archived AS walletArchived FROM imported_token_projects p
      LEFT JOIN imported_market_observations m ON m.owner_id=p.owner_id AND m.project_id=p.id
      LEFT JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.address=? AND w.chain='Solana'
      WHERE p.owner_id=? AND p.id=? AND EXISTS(SELECT 1 FROM conditional_sell_orders o WHERE o.owner_id=p.owner_id AND o.project_id=p.id AND o.id=? AND o.state='draft' AND o.revision=? AND o.document=?)`)
      .bind(
        terms.wallet,
        owner,
        projectId,
        orderId,
        existing.revision,
        existing.document,
      )
      .first<{
        revision: number;
        archived: number;
        chain: string;
        address: string;
        market: string | null;
        walletRevision: number | null;
        walletArchived: number | null;
      }>();
    if (
      !context ||
      context.archived ||
      context.walletArchived !== 0 ||
      context.walletRevision !== terms.walletRevision ||
      context.revision !== terms.projectRevision ||
      context.chain !== 'Solana' ||
      context.address !== terms.mint
    )
      return json(
        { error: 'Project or wallet changed. This draft needs replacement.' },
        409,
      );
    try {
      const observations: SavedTokenMarket[] = JSON.parse(
        context.market ?? '[]',
      );
      const reviews = terms.levels.map((level) =>
        reviewMarketTrigger(
          {
            pair: terms.pair,
            direction: terms.direction,
            targetUsd: level.targetUsd,
          },
          observations[0],
          {
            chain: context.chain,
            mint: terms.mint,
            revision: terms.projectRevision,
          },
        ),
      );
      return json({
        orderId,
        revision: existing.revision,
        reviews,
        executionAllowed: false,
      });
    } catch {
      return json(
        {
          error:
            'Refresh selected-pool market data before reviewing this draft.',
        },
        422,
      );
    }
  } catch (error) {
    return json(
      {
        error:
          error instanceof ConditionalBuyStorageUnavailable
            ? error.message
            : 'Conditional order storage unavailable.',
      },
      503,
    );
  }
}
