import {
  createWalletWarmupSessionProviderCore,
  type WarmupSessionProviderDependencies,
} from './wallet-warmup-session-provider-core';
export {
  WalletWarmupSessionProviderError,
  WARMUP_SESSION_PREPARATION_TIMEOUT_MS,
  WARMUP_SESSION_PROVIDER_COOLDOWN_MS,
} from './wallet-warmup-session-provider-core';

/** Legacy snapshot adapter only. V2 histories cannot enter this provider path. */
export function createWalletWarmupSessionProvider(
  db: D1Database,
  owner: string,
  apiKey: string | undefined,
  deps: WarmupSessionProviderDependencies = {},
) {
  return createWalletWarmupSessionProviderCore(
    db,
    owner,
    apiKey,
    async (c, _signal) => {
      const row = await db
        .prepare(
          "SELECT p.document,(EXISTS(SELECT 1 FROM json_each(p.document,'$.addresses') a JOIN solana_swap_reservations r ON r.owner_id=p.owner_id AND r.wallet_address=a.value) OR EXISTS(SELECT 1 FROM json_each(p.document,'$.addresses') a JOIN solana_execution_reservations r ON r.owner_id=p.owner_id AND r.wallet_address=a.value)) AS busy FROM wallet_warmup_plans p JOIN wallet_warmup_session_journal_heads h ON h.owner_id=p.owner_id WHERE p.owner_id=? AND p.id=? AND p.revision=? AND p.updated_at=? AND p.archived=0 AND h.journal_id=? AND h.version=? AND h.head_sha256=? AND (SELECT COUNT(*) FROM json_each(json_extract(p.document,'$.walletRevisions')) j JOIN workspace_wallets w ON w.owner_id=p.owner_id AND w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision') AND w.chain='Solana' AND w.archived=0)=json_array_length(json_extract(p.document,'$.addresses'))",
        )
        .bind(
          owner,
          c.plan.id,
          c.plan.revision,
          c.plan.updatedAt,
          c.journalId,
          c.version,
          c.headSha256,
        )
        .first<{ document: string; busy: number }>();
      return row;
    },
    deps,
  );
}
