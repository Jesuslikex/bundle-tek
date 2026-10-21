import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { WARMUP_RUNTIME_WALLET_BUSY_SQL } from './wallet-warmup-runtime-wallet-busy';
import {
  createWalletWarmupSessionProviderCore,
  type WarmupSessionProviderDependencies,
  type WarmupSessionProviderPlanReader,
} from './wallet-warmup-session-provider-core';
import {
  warmupV2AttemptRow,
  type WarmupV2AttemptRow,
} from './wallet-warmup-session-v2-attempt-types';

/** Trusted lease adapter only. The lease INSERT already atomically claimed cooldown. */
export function createWalletWarmupV2Provider(
  db: D1Database,
  owner: string,
  apiKey: string | undefined,
  lease: WarmupV2AttemptRow,
  deps: WarmupSessionProviderDependencies = {},
  runtimeWalletAvailability = false,
) {
  const original = structuredClone(warmupV2AttemptRow.parse(lease));
  const read: WarmupSessionProviderPlanReader = async (candidate, signal) => {
    signal.throwIfAborted();
    if (
      owner !== original.owner_id ||
      candidate.journalId !== original.journal_id ||
      candidate.version !== original.review_version ||
      candidate.headSha256 !== original.review_sha256 ||
      candidate.action.id !== original.action_id ||
      candidate.deadline !== Date.parse(original.expires_at)
    )
      return null;
    const row = await db
      .prepare(`SELECT c.plan_document,c.action_document,c.review_document${runtimeWalletAvailability ? `,${WARMUP_RUNTIME_WALLET_BUSY_SQL} AS runtime_busy` : ''}
 FROM wallet_warmup_session_v2_attempt_context c JOIN wallet_warmup_session_v2_attempts a ON a.owner_id=c.owner_id AND a.journal_id=c.journal_id
 WHERE a.owner_id=? AND a.id=? AND a.review_version=c.version AND a.review_sha256=c.head_sha256 AND a.terms_sha256=c.terms_sha256
 AND a.action_id=c.action_id AND a.created_at=? AND a.expires_at=? AND strftime('%Y-%m-%dT%H:%M:%fZ','now')<a.expires_at
 AND c.plan_id=? AND c.plan_revision=? AND c.plan_updated_at=?
 AND NOT EXISTS(SELECT 1 FROM wallet_warmup_session_v2_attempt_outcomes o WHERE o.owner_id=a.owner_id AND o.attempt_id=a.id)`)
      .bind(
        owner,
        original.id,
        original.created_at,
        original.expires_at,
        candidate.plan.id,
        candidate.plan.revision,
        candidate.plan.updatedAt,
      )
      .first<{
        plan_document: string;
        action_document: string;
        review_document: string;
        runtime_busy?: number;
      }>();
    signal.throwIfAborted();
    if (
      !row ||
      canonical(JSON.parse(row.action_document)) !== canonical(candidate.action)
    )
      return null;
    const wallets = JSON.parse(row.review_document).wallets as {
      wallet: string;
      buySpendLamports: string;
      remainingFeeReserveLamports: string;
    }[];
    const wallet = wallets.find((w) => w.wallet === candidate.action.wallet);
    if (
      !wallet ||
      candidate.budget.buySpendLamports !== wallet.buySpendLamports ||
      candidate.budget.recordedFurtherBuySpendLamports !== '0' ||
      candidate.budget.remainingReserveLamports !==
        wallet.remainingFeeReserveLamports
    )
      return null;
    const action = candidate.action;
    if (
      action.side === 'Sell' &&
      (action.source.kind !== 'saved-buy' ||
        canonical(candidate.sellSource) !==
          canonical({
            buyReceiptId: action.source.buyReceiptId,
            remainingRaw: action.source.remainingRaw,
            decimals: action.source.decimals,
          }))
    )
      return null;
    if (runtimeWalletAvailability && ![0, 1].includes(row.runtime_busy!))
      return null;
    return {
      document: row.plan_document,
      busy: runtimeWalletAvailability ? row.runtime_busy! : 0,
    };
  };
  return createWalletWarmupSessionProviderCore(db, owner, apiKey, read, deps, {
    id: original.id,
    createdAt: original.created_at,
    expiresAt: original.expires_at,
  });
}
