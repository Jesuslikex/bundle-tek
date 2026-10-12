import type { WarmupSigningReview } from '@/lib/warmup-signing';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { UUID } from '@/lib/wallet-operation';
import { transactionSignature } from '@/lib/tracked-wallet-transaction';
import {
  observeWarmupBuyReceipt,
  type SavedWarmupBuyReceipt,
} from '@/lib/warmup-buy-receipt';
import type { SavedWarmupPreparation } from '@/lib/warmup-preparation-history';
import { WARMUP_HISTORY_LIMIT } from '@/lib/warmup-history-capacity';
import {
  warmupReceiptCursor,
  warmupReceiptPage,
} from '@/lib/warmup-receipt-history';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
type ReceiptRow = Omit<SavedWarmupBuyReceipt, 'document'> & {
  document: string;
};
const columns =
  'id,preparation_id AS preparationId,plan_id AS planId,plan_revision AS planRevision,cycle,wallet_revision AS walletRevision,created_at AS createdAt,remaining_raw AS remainingRaw,document';
const decode = (row: ReceiptRow) =>
  ({ ...row, document: JSON.parse(row.document) }) as SavedWarmupBuyReceipt;
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view buy receipts.' }, 401);
  const url = new URL(request.url),
    planId = url.searchParams.get('id');
  if (!planId || !/^[a-zA-Z0-9-]{1,64}$/.test(planId))
    return json({ error: 'Choose a saved warmup.' }, 400);
  let cursor;
  try {
    cursor = warmupReceiptCursor(url.searchParams.get('cursor'));
  } catch {
    return json({ error: 'Invalid buy receipt cursor.' }, 400);
  }
  try {
    const db = getD1();
    if (
      !(await db
        .prepare('SELECT id FROM wallet_warmup_plans WHERE owner_id=? AND id=?')
        .bind(user.userId, planId)
        .first())
    )
      return json({ error: 'Warmup unavailable.' }, 404);
    const page = await warmupReceiptPage<ReceiptRow>(
      db,
      'buy',
      columns,
      user.userId,
      planId,
      cursor,
    );
    if (!page) return json({ error: 'Buy receipt cursor unavailable.' }, 400);
    return json({
      planId,
      executionAllowed: false,
      receipts: page.rows.map(decode),
      nextCursor: page.nextCursor,
    });
  } catch {
    return json({ error: 'Buy receipt history unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to verify a buy receipt.' }, 401);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin request rejected.' }, 403);
  let preparationId: string, signature: string;
  try {
    const text = await request.text();
    if (text.length > 300) return json({ error: 'Request too large.' }, 413);
    const body = JSON.parse(text);
    if (!body || !UUID.test(body.preparationId)) throw new Error();
    preparationId = body.preparationId;
    signature = transactionSignature(body.signature);
  } catch {
    return json(
      {
        error: 'Choose a saved buy preparation and its transaction signature.',
      },
      400,
    );
  }
  try {
    const db = getD1();
    const prior = () =>
      db
        .prepare(
          `SELECT ${columns} FROM warmup_buy_receipts WHERE owner_id=? AND preparation_id=?`,
        )
        .bind(user.userId, preparationId)
        .first<ReceiptRow>();
    const resolveIntent = (signature: string) =>
      db
        .prepare(
          "UPDATE warmup_signing_intents SET state='finalized',updated_at=? WHERE owner_id=? AND preparation_id=? AND signature=? AND state IN ('signed','submitted')",
        )
        .bind(new Date().toISOString(), user.userId, preparationId, signature)
        .run();
    const existing = await prior();
    if (existing) {
      const receipt = decode(existing);
      if (receipt.document.signature === signature)
        await resolveIntent(signature);
      return receipt.document.signature === signature
        ? json({ executionAllowed: false, receipt })
        : json(
            { error: 'This preparation already has a different receipt.' },
            409,
          );
    }
    type PreparationRow = Omit<SavedWarmupPreparation, 'document'> & {
      document: string;
      planDocument: string;
    };
    const row = await db
      .prepare(`SELECT s.id,s.plan_id AS planId,s.plan_revision AS planRevision,s.cycle,s.wallet_revision AS walletRevision,s.created_at AS createdAt,s.document,p.document AS planDocument
      FROM warmup_swap_preparations s JOIN wallet_warmup_plans p ON p.owner_id=s.owner_id AND p.id=s.plan_id
      WHERE s.owner_id=? AND s.id=? AND ((p.revision=s.plan_revision AND p.archived=0
      AND (SELECT COUNT(*) FROM json_each(json_extract(p.document,'$.walletRevisions')) j JOIN workspace_wallets w ON w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision') WHERE w.owner_id=p.owner_id AND w.chain='Solana' AND w.archived=0)=json_array_length(json_extract(p.document,'$.addresses'))) OR EXISTS(SELECT 1 FROM warmup_signing_intents i WHERE i.owner_id=s.owner_id AND i.preparation_id=s.id AND i.signature=? AND i.state IN ('signed','submitted')) )`)
      .bind(user.userId, preparationId, signature)
      .first<PreparationRow>();
    if (!row)
      return json(
        {
          error: 'Buy preparation or saved plan/wallet revisions unavailable.',
        },
        409,
      );
    const preparation: SavedWarmupPreparation = {
      ...row,
      document: JSON.parse(row.document),
    };
    if (preparation.document.side !== 'Buy')
      return json({ error: 'Choose a saved buy preparation.' }, 400);
    const count = await db
      .prepare(
        'SELECT COUNT(*) AS n FROM warmup_buy_receipts WHERE owner_id=? AND plan_id=?',
      )
      .bind(user.userId, row.planId)
      .first<{ n: number }>();
    if (!count || count.n >= WARMUP_HISTORY_LIMIT)
      return json({ error: 'Buy receipt history is full.' }, 409);
    const now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
      )
      .bind(user.userId, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      return json({ error: 'Wait 15 seconds between wallet reads.' }, 429);
    const intent = await db
      .prepare(
        "SELECT document FROM warmup_signing_intents WHERE owner_id=? AND preparation_id=? AND signature=? AND state IN ('signed','submitted')",
      )
      .bind(user.userId, preparationId, signature)
      .first<{ document: string }>();
    const approval = intent
      ? (JSON.parse(intent.document) as WarmupSigningReview)
      : undefined;
    let document;
    try {
      document = await observeWarmupBuyReceipt(
        preparation,
        signature,
        AbortSignal.any([request.signal, AbortSignal.timeout(25000)]),
        fetch,
        approval,
      );
    } catch {
      return json(
        {
          error:
            'Finalized receipt unavailable or does not match the saved buy packet and acquired token units.',
        },
        502,
      );
    }
    const id = crypto.randomUUID(),
      createdAt = new Date().toISOString(),
      text = JSON.stringify(document);
    if (
      text.length > 8192 ||
      document.executionAllowed !== false ||
      document.instructionsVerified !== false ||
      document.signatureVerified !== true ||
      document.signature !== signature ||
      document.wallet !== preparation.document.wallet ||
      document.mint !== preparation.document.outputMint ||
      document.preparationSha256 !== preparation.document.transaction.sha256 ||
      document.commitment !== 'finalized' ||
      document.network !== 'mainnet'
    )
      return json({ error: 'Receipt summary unavailable.' }, 502);
    const write = await db
      .prepare(`INSERT OR IGNORE INTO warmup_buy_receipts (id,owner_id,preparation_id,plan_id,plan_revision,cycle,wallet_address,wallet_revision,signature,document,remaining_raw,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE
      (EXISTS(SELECT 1 FROM wallet_warmup_plans p WHERE p.owner_id=? AND p.id=? AND p.revision=? AND p.archived=0 AND p.document=?
        AND (SELECT COUNT(*) FROM json_each(json_extract(p.document,'$.walletRevisions')) j JOIN workspace_wallets w ON w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision') WHERE w.owner_id=p.owner_id AND w.chain='Solana' AND w.archived=0)=json_array_length(json_extract(p.document,'$.addresses'))) OR EXISTS(SELECT 1 FROM warmup_signing_intents i WHERE i.owner_id=? AND i.preparation_id=? AND i.signature=? AND i.state IN ('signed','submitted')))
      AND EXISTS(SELECT 1 FROM warmup_swap_preparations WHERE owner_id=? AND id=? AND document=?)
      AND (SELECT COUNT(*) FROM warmup_buy_receipts WHERE owner_id=? AND plan_id=?)<?`)
      .bind(
        id,
        user.userId,
        preparationId,
        row.planId,
        row.planRevision,
        row.cycle,
        document.wallet,
        row.walletRevision,
        signature,
        text,
        document.acquiredRaw,
        createdAt,
        user.userId,
        row.planId,
        row.planRevision,
        row.planDocument,
        user.userId,
        preparationId,
        signature,
        user.userId,
        preparationId,
        row.document,
        user.userId,
        row.planId,
        WARMUP_HISTORY_LIMIT,
      )
      .run();
    if (!write.meta.changes) {
      const concurrent = await prior();
      if (concurrent && decode(concurrent).document.signature === signature)
        return json({ executionAllowed: false, receipt: decode(concurrent) });
      return json(
        {
          error:
            'Plan/wallet revisions changed, receipt was already linked or history is full.',
        },
        409,
      );
    }
    await resolveIntent(signature);
    return json({
      executionAllowed: false,
      receipt: {
        id,
        preparationId,
        planId: row.planId,
        planRevision: row.planRevision,
        cycle: row.cycle,
        walletRevision: row.walletRevision,
        createdAt,
        document,
      } satisfies SavedWarmupBuyReceipt,
    });
  } catch {
    return json({ error: 'Buy receipt storage unavailable.' }, 503);
  }
}
