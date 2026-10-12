import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  ACCOUNT_PERFORMANCE_LIMIT,
  accountPerformanceCsv,
  type ImportedPerformanceSource,
  type WarmupPerformanceSource,
} from '@/lib/account-performance';
import {
  summarizeAccountPerformance,
  summarizeAccountTimeline,
} from '@/lib/account-performance-server';
import {
  IMPORTED_LOT_LINK_LIMIT,
  type ImportedLotLink,
} from '@/lib/imported-lot-links';
import { importedTradeReceipt } from '@/lib/imported-trade-ledger';
import type {
  PerformanceBuy,
  PerformanceSell,
} from '@/lib/warmup-lot-performance';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
type Stored = Record<string, unknown> & {
  document: string;
  scopeId: string;
  scopeDocument: string;
  scopeArchived: number;
};
export async function GET(request?: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json(
      { error: 'Sign in to view recorded trading performance.' },
      401,
    );
  const params = request
    ? new URL(request.url).searchParams
    : new URLSearchParams();
  if (
    [...params.keys()].some((k) => k !== 'format' && k !== 'view') ||
    params.getAll('format').length > 1 ||
    params.getAll('view').length > 1 ||
    (params.has('format') && params.get('format') !== 'csv') ||
    (params.has('view') && params.get('view') !== 'timeline') ||
    (params.has('format') && params.has('view'))
  )
    return json({ error: 'Unsupported performance export format.' }, 400);
  try {
    const db = getD1();
    // One D1 batch provides a coherent owner snapshot, including archived scopes and all revisions.
    const queries = [
      `SELECT r.id,r.project_id AS projectId,r.preparation_id AS preparationId,r.project_revision AS projectRevision,r.wallet_revision AS walletRevision,r.created_at AS createdAt,r.document,p.id AS scopeId,p.document AS scopeDocument,p.archived AS scopeArchived FROM imported_swap_receipts r LEFT JOIN imported_token_projects p ON p.owner_id=r.owner_id AND p.id=r.project_id WHERE r.owner_id=? LIMIT ?`,
      `SELECT l.id,l.project_id AS projectId,l.buy_receipt_id AS buyReceiptId,l.sell_receipt_id AS sellReceiptId,l.units_raw AS unitsRaw,l.buy_signature AS buySignature,l.sell_signature AS sellSignature,l.buy_preparation_sha256 AS buyPreparationSha256,l.sell_preparation_sha256 AS sellPreparationSha256,l.created_at AS createdAt FROM imported_trade_lot_links l WHERE l.owner_id=? LIMIT ?`,
      `SELECT r.id,r.plan_id AS planId,r.signature,r.document,r.plan_revision AS planRevision,r.wallet_revision AS walletRevision,r.cycle,r.wallet_address AS wallet,json_extract(r.document,'$.mint') AS mint,json_extract(r.document,'$.acquiredRaw') AS acquiredRaw,COALESCE(r.remaining_raw,json_extract(r.document,'$.acquiredRaw')) AS remainingRaw,json_extract(r.document,'$.decimals') AS decimals,CASE WHEN json_extract(r.document,'$.signatureVerified')=1 AND json_extract(r.document,'$.wallet')=r.wallet_address AND json_extract(r.document,'$.signature')=r.signature THEN 1 ELSE 0 END AS verified,json_extract(r.document,'$.commitment') AS commitment,json_extract(r.document,'$.network') AS network,p.id AS scopeId,p.document AS scopeDocument,p.archived AS scopeArchived FROM warmup_buy_receipts r LEFT JOIN wallet_warmup_plans p ON p.owner_id=r.owner_id AND p.id=r.plan_id WHERE r.owner_id=? LIMIT ?`,
      `SELECT r.id,r.plan_id AS planId,r.signature,r.document,r.buy_receipt_id AS buyId,r.consumed_raw AS consumedRaw,CASE WHEN json_extract(r.document,'$.signatureVerified')=1 AND json_extract(r.document,'$.signature')=r.signature AND json_extract(r.document,'$.consumedRaw')=r.consumed_raw AND json_extract(r.document,'$.buyReceiptId')=r.buy_receipt_id THEN 1 ELSE 0 END AS verified,json_extract(r.document,'$.commitment') AS commitment,json_extract(r.document,'$.network') AS network,p.id AS scopeId,p.document AS scopeDocument,p.archived AS scopeArchived FROM warmup_sell_receipts r LEFT JOIN wallet_warmup_plans p ON p.owner_id=r.owner_id AND p.id=r.plan_id WHERE r.owner_id=? LIMIT ?`,
    ];
    const results = await db.batch(
      queries.map((q, i) =>
        db
          .prepare(q)
          .bind(
            user.userId,
            (i === 1 ? IMPORTED_LOT_LINK_LIMIT : ACCOUNT_PERFORMANCE_LIMIT) + 1,
          ),
      ),
    );
    if (
      results.some(
        (r, i) =>
          !r.success ||
          r.results.length >
            (i === 1 ? IMPORTED_LOT_LINK_LIMIT : ACCOUNT_PERFORMANCE_LIMIT),
      )
    )
      throw new Error('Incomplete snapshot.');
    const imports = new Map<string, ImportedPerformanceSource>(),
      warmups = new Map<string, WarmupPerformanceSource>();
    for (const row of results[0].results as Stored[]) {
      if (!row.scopeId || ![0, 1].includes(row.scopeArchived))
        throw new Error('Missing project.');
      const token = JSON.parse(row.scopeDocument).token;
      if (token.chain !== 'Solana') throw new Error('Unsupported project.');
      const receipt = importedTradeReceipt(
        { ...row, document: JSON.parse(row.document) },
        row.scopeId,
        token.address,
        token.decimals,
      );
      const source: ImportedPerformanceSource = imports.get(row.scopeId) ?? {
        id: row.scopeId,
        name: token.name,
        archived: row.scopeArchived === 1,
        receipts: [],
        links: [],
      };
      source.receipts.push(receipt);
      imports.set(row.scopeId, source);
    }
    for (const row of results[1].results as ImportedLotLink[]) {
      const source = imports.get(row.projectId);
      if (!source) throw new Error('Orphan acquisition link.');
      source.links.push(row);
    }
    for (const [index, side] of [
      [2, 'buys'],
      [3, 'sells'],
    ] as const) {
      for (const row of results[index].results as Stored[]) {
        if (!row.scopeId || ![0, 1].includes(row.scopeArchived))
          throw new Error('Missing warmup plan.');
        const plan = JSON.parse(row.scopeDocument);
        const source: WarmupPerformanceSource = warmups.get(row.scopeId) ?? {
          id: row.scopeId,
          name: plan.name,
          archived: row.scopeArchived === 1,
          buys: [],
          sells: [],
        };
        const receipt = { ...row, document: JSON.parse(row.document) };
        if (side === 'buys')
          source.buys.push(receipt as unknown as PerformanceBuy);
        else source.sells.push(receipt as unknown as PerformanceSell);
        warmups.set(row.scopeId, source);
      }
    }
    if (params.get('view') === 'timeline')
      return json(
        summarizeAccountTimeline(
          [...imports.values()],
          [...warmups.values()],
          new Date().toISOString(),
        ),
      );
    const summary = summarizeAccountPerformance(
      [...imports.values()],
      [...warmups.values()],
      new Date().toISOString(),
    );
    if (params.get('format') === 'csv')
      return new Response(accountPerformanceCsv(summary), {
        headers: {
          'content-type': 'text/csv;charset=utf-8',
          'content-disposition':
            'attachment; filename="bundle-recorded-performance.csv"',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    return json(summary);
  } catch {
    return json(
      {
        error:
          'Recorded trading performance unavailable. No partial totals are shown.',
      },
      503,
    );
  }
}
