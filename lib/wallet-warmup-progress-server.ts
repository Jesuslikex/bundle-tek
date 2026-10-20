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
export class WalletWarmupProgressError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function loadWalletWarmupProgress(
  db: D1Database,
  owner: string,
  id: string,
  revision: number,
  includeEarlier: boolean,
  requireCurrentWallets = false,
) {
  const statements = [
    db
      .prepare(
        'SELECT revision,archived,updated_at AS updatedAt,document FROM wallet_warmup_plans WHERE owner_id=? AND id=?',
      )
      .bind(owner, id),
    db
      .prepare(
        `SELECT document,id,plan_revision AS planRevision,wallet_revision AS walletRevision,cycle,wallet_address AS wallet,json_extract(document,'$.mint') AS mint,json_extract(document,'$.acquiredRaw') AS acquiredRaw,COALESCE(remaining_raw,json_extract(document,'$.acquiredRaw')) AS remainingRaw,json_extract(document,'$.decimals') AS decimals,CASE WHEN json_extract(document,'$.signatureVerified')=1 AND json_extract(document,'$.wallet')=wallet_address AND json_extract(document,'$.signature')=signature THEN 1 ELSE 0 END AS verified,json_extract(document,'$.commitment') AS commitment,json_extract(document,'$.network') AS network FROM warmup_buy_receipts WHERE owner_id=? AND plan_id=? LIMIT ?`,
      )
      .bind(owner, id, WARMUP_HISTORY_LIMIT + 1),
    db
      .prepare(
        `SELECT document,id,buy_receipt_id AS buyId,consumed_raw AS consumedRaw,CASE WHEN json_extract(document,'$.signatureVerified')=1 AND json_extract(document,'$.signature')=signature AND json_extract(document,'$.consumedRaw')=consumed_raw AND json_extract(document,'$.buyReceiptId')=buy_receipt_id THEN 1 ELSE 0 END AS verified,json_extract(document,'$.commitment') AS commitment,json_extract(document,'$.network') AS network FROM warmup_sell_receipts WHERE owner_id=? AND plan_id=? LIMIT ?`,
      )
      .bind(owner, id, WARMUP_HISTORY_LIMIT + 1),
    db
      .prepare(
        `SELECT i.intent_id AS id,i.wallet_address AS wallet,i.state FROM solana_swap_reservations i WHERE i.owner_id=? AND i.wallet_address IN (SELECT json_extract(j.value,'$.address') FROM wallet_warmup_plans p,json_each(p.document,'$.walletRevisions') j WHERE p.owner_id=? AND p.id=?) LIMIT 101`,
      )
      .bind(owner, owner, id),
  ];
  if (requireCurrentWallets)
    statements.push(
      db
        .prepare(
          `SELECT COUNT(*) AS walletCount FROM wallet_warmup_plans p,json_each(p.document,'$.walletRevisions') j JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.chain=json_extract(p.document,'$.chain') AND w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision') AND w.archived=0 WHERE p.owner_id=? AND p.id=? AND p.revision=? AND p.archived=0`,
        )
        .bind(owner, id, revision),
    );
  const results = await db.batch(statements);
  const row = results[0].results[0] as
    | {
        revision: number;
        archived: number;
        updatedAt: string;
        document: string;
      }
    | undefined;
  if (!row) throw new WalletWarmupProgressError(404, 'Warmup unavailable.');
  if (row.revision !== revision)
    throw new WalletWarmupProgressError(
      409,
      'Saved plan changed. Reload it before viewing progress.',
    );
  const plan: SavedWarmup = {
    id,
    ...row,
    archived: Boolean(row.archived),
    document: JSON.parse(row.document),
  };
  const currentWallets = results[4]?.results[0] as
    | { walletCount: unknown }
    | undefined;
  if (
    requireCurrentWallets &&
    currentWallets?.walletCount !== plan.document.addresses.length
  )
    throw new WalletWarmupProgressError(
      409,
      'Saved plan or wallet revisions changed, or the plan is archived. Reload the plan.',
    );
  if (plan.document.chain !== 'Solana')
    throw new WalletWarmupProgressError(
      400,
      'Recorded cycle progress currently supports Solana.',
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
    includeEarlier,
  );
  const performance = warmupLotPerformance(
    buys,
    sells,
    progress.steps.flatMap((step) => step.buyIds),
  );

  return { plan, progress, performance };
}
