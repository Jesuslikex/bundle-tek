import { WalletWarmupV2AttemptError } from './wallet-warmup-session-v2-attempt-types';
/** Read-only advisory checks over the original owned context alias c.
 * These do not reserve funds or close an authorization/broadcast race.
 * Keep normal preview/legacy queries independent of these runtime parents.
 */
export const WARMUP_RUNTIME_WALLET_BUSY_SQL = `CASE WHEN EXISTS (
 SELECT 1 FROM json_each(c.review_document,'$.wallets') selected
 WHERE EXISTS(SELECT 1 FROM pair_order_executions e WHERE e.owner_id=c.owner_id
  AND e.wallet=json_extract(selected.value,'$.wallet') AND e.state IN ('reserved','signed','submitting','submitted'))
 OR EXISTS(SELECT 1 FROM pump_launch_reviews r WHERE r.owner_id=c.owner_id
  AND r.state NOT IN ('cancelled','failed','finalized') AND (r.payer=json_extract(selected.value,'$.wallet')
   OR EXISTS(SELECT 1 FROM json_each(r.review,'$.input.holders') h
    WHERE json_extract(r.review,'$.format') IN ('pump-create-holders-review-v1','pump-launch-group-review-v1')
    AND json_extract(h.value,'$.kind')!='none' AND json_extract(h.value,'$.address')=json_extract(selected.value,'$.wallet'))))
 OR EXISTS(SELECT 1 FROM volume_bot_sessions s,json_each(s.plan,'$.wallets') w
  WHERE s.owner_id=c.owner_id AND w.value=json_extract(selected.value,'$.wallet')
  AND (s.state='active' OR EXISTS(SELECT 1 FROM volume_bot_batches batch JOIN volume_bot_trades t ON t.batch_id=batch.id
   WHERE batch.session_id=s.id AND t.state IN ('signed','submitting','submitted'))))
 OR EXISTS(SELECT 1 FROM volume_bundle_reservations b WHERE b.owner_id=c.owner_id
  AND b.wallet=json_extract(selected.value,'$.wallet') AND b.state IN ('held','attempted'))
 OR EXISTS(SELECT 1 FROM pump_organic_sequences s,json_each(s.plan,'$.rows') w
  WHERE s.owner_id=c.owner_id AND json_extract(w.value,'$.address')=json_extract(selected.value,'$.wallet')
  AND (s.state='active' OR EXISTS(SELECT 1 FROM pump_organic_batches batch JOIN pump_organic_buys t ON t.batch_id=batch.id
   WHERE batch.sequence_id=s.id AND t.state IN ('signed','submitting','submitted'))))
 OR EXISTS(SELECT 1 FROM wallet_cleanups x WHERE x.owner_id=c.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet')
  AND x.state IN ('awaiting_signature','signing','signed','submitted'))
 OR EXISTS(SELECT 1 FROM token_supply_actions x WHERE x.owner_id=c.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet')
  AND x.state IN ('awaiting_signature','signing','signed','submitted'))
 OR EXISTS(SELECT 1 FROM sniper_nuke_sells x WHERE x.owner_id=c.owner_id AND x.wallet=json_extract(selected.value,'$.wallet')
  AND x.state IN ('review','signed','submitting','submitted'))
 OR EXISTS(SELECT 1 FROM counter_proposal_reservations x WHERE x.owner_id=c.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet')
  AND (x.approval_id IS NOT NULL OR x.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
) THEN 1 ELSE 0 END`;

/** Friendly preflight; the lease INSERT repeats the same expression atomically. */
export async function requireWarmupRuntimeWalletAvailability(
  db: D1Database,
  owner: string,
  input: { journalId: string; version: number; headSha256: string },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let row: { busy: number } | null;
  try {
    row = await db
      .prepare(`SELECT ${WARMUP_RUNTIME_WALLET_BUSY_SQL} AS busy FROM wallet_warmup_session_v2_attempt_context c
   WHERE c.owner_id=? AND c.journal_id=? AND c.version=? AND c.head_sha256=?`)
      .bind(owner, input.journalId, input.version, input.headSha256)
      .first<{ busy: number }>();
  } catch {
    throw new WalletWarmupV2AttemptError(
      'Runtime wallet availability is unavailable. Recover saved status before retrying.',
      503,
    );
  }
  signal.throwIfAborted();
  if (!row)
    throw new WalletWarmupV2AttemptError(
      'The current owned warmup review changed. Recover its status.',
      409,
    );
  if (row.busy === 1)
    throw new WalletWarmupV2AttemptError(
      'A selected wallet has active transaction work. Finish or recover it before another warmup request.',
      409,
    );
  if (row.busy !== 0)
    throw new WalletWarmupV2AttemptError(
      'Runtime wallet availability is unavailable.',
      503,
    );
}
