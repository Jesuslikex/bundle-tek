import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  warmupCycleProgress,
  type ProgressApproval,
} from '@/lib/warmup-cycle-progress';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import { WARMUP_HISTORY_LIMIT } from '@/lib/warmup-history-capacity';
import {
  warmupLotPerformance,
  type PerformanceBuy,
  type PerformanceSell,
} from '@/lib/warmup-lot-performance';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view cycle progress.' }, 401);
  const params = new URL(request.url).searchParams,
    id = params.get('id'),
    revision = params.get('revision'),
    earlier = params.get('includeEarlier');
  if (
    !id ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(id) ||
    !revision ||
    !/^[1-9]\d{0,8}$/.test(revision) ||
    (earlier !== null && earlier !== 'true' && earlier !== 'false')
  )
    return json(
      { error: 'Choose a saved plan revision and progress scope.' },
      400,
    );
  try {
    const db = getD1();
    const results = await db.batch([
      db
        .prepare(
          'SELECT revision,archived,updated_at AS updatedAt,document FROM wallet_warmup_plans WHERE owner_id=? AND id=?',
        )
        .bind(user.userId, id),
      db
        .prepare(
          `SELECT document,id,plan_revision AS planRevision,wallet_revision AS walletRevision,cycle,wallet_address AS wallet,json_extract(document,'$.mint') AS mint,json_extract(document,'$.acquiredRaw') AS acquiredRaw,COALESCE(remaining_raw,json_extract(document,'$.acquiredRaw')) AS remainingRaw,json_extract(document,'$.decimals') AS decimals,CASE WHEN json_extract(document,'$.signatureVerified')=1 AND json_extract(document,'$.wallet')=wallet_address AND json_extract(document,'$.signature')=signature THEN 1 ELSE 0 END AS verified,json_extract(document,'$.commitment') AS commitment,json_extract(document,'$.network') AS network FROM warmup_buy_receipts WHERE owner_id=? AND plan_id=? LIMIT ?`,
        )
        .bind(user.userId, id, WARMUP_HISTORY_LIMIT + 1),
      db
        .prepare(
          `SELECT document,id,buy_receipt_id AS buyId,consumed_raw AS consumedRaw,CASE WHEN json_extract(document,'$.signatureVerified')=1 AND json_extract(document,'$.signature')=signature AND json_extract(document,'$.consumedRaw')=consumed_raw AND json_extract(document,'$.buyReceiptId')=buy_receipt_id THEN 1 ELSE 0 END AS verified,json_extract(document,'$.commitment') AS commitment,json_extract(document,'$.network') AS network FROM warmup_sell_receipts WHERE owner_id=? AND plan_id=? LIMIT ?`,
        )
        .bind(user.userId, id, WARMUP_HISTORY_LIMIT + 1),
      db
        .prepare(
          `SELECT i.intent_id AS id,i.wallet_address AS wallet,i.state FROM solana_swap_reservations i WHERE i.owner_id=? AND i.wallet_address IN (SELECT json_extract(j.value,'$.address') FROM wallet_warmup_plans p,json_each(p.document,'$.walletRevisions') j WHERE p.owner_id=? AND p.id=?) LIMIT 101`,
        )
        .bind(user.userId, user.userId, id),
    ]);
    const row = results[0].results[0] as
      | {
          revision: number;
          archived: number;
          updatedAt: string;
          document: string;
        }
      | undefined;
    if (!row) return json({ error: 'Warmup unavailable.' }, 404);
    if (row.revision !== Number(revision))
      return json(
        { error: 'Saved plan changed. Reload it before viewing progress.' },
        409,
      );
    const plan: SavedWarmup = {
      id,
      ...row,
      archived: Boolean(row.archived),
      document: JSON.parse(row.document),
    };
    if (plan.document.chain !== 'Solana')
      return json(
        { error: 'Recorded cycle progress currently supports Solana.' },
        400,
      );
    if (results[3].results.length > 100)
      throw new Error('Approval capacity exceeded.');
    const buys = (results[1].results as Array<Record<string, unknown>>).map(
      (row) => ({
        ...row,
        document: JSON.parse(row.document as string),
      }),
    ) as PerformanceBuy[];
    const sells = (results[2].results as Array<Record<string, unknown>>).map(
      (row) => ({
        ...row,
        document: JSON.parse(row.document as string),
      }),
    ) as PerformanceSell[];
    const progress = warmupCycleProgress(
      plan,
      buys,
      sells,
      results[3].results as ProgressApproval[],
      earlier === 'true',
    );
    const performance = warmupLotPerformance(
      buys,
      sells,
      progress.steps.flatMap((step) => step.buyIds),
    );
    return json({ ...progress, performance });
  } catch {
    return json(
      {
        error:
          'Recorded cycle progress unavailable. No completion is inferred.',
      },
      503,
    );
  }
}
