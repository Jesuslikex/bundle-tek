/** Additive read-only advisory over the original owned context alias c.
 * Match actual unresolved child wallets under stopped parents or inherited
 * legacy roster discrepancies. Current parent immutability/member guards remain
 * independent. Foreign keys join IDs, not owners: any matching child, batch or
 * parent owner conservatively keeps that selected wallet unavailable. LEFT JOIN
 * also retains an owned orphan child from inconsistent legacy data.
 * This creates no wallet lease, fund reservation or signing/execution authority,
 * and does not close an authorization or broadcast race. Compose with the existing
 * busy expression; do not replace or reinterpret its parent-roster checks.
 */
export const WARMUP_RUNTIME_UNRESOLVED_WALLETS_SQL = `CASE WHEN EXISTS (
 SELECT 1 FROM json_each(c.review_document,'$.wallets') selected
 WHERE EXISTS (
  SELECT 1 FROM volume_bot_trades t
  LEFT JOIN volume_bot_batches b ON b.id=t.batch_id
  LEFT JOIN volume_bot_sessions s ON s.id=b.session_id
  WHERE t.wallet=json_extract(selected.value,'$.wallet')
   AND t.state IN ('signed','submitting','submitted')
   AND (t.owner_id=c.owner_id OR b.owner_id=c.owner_id OR s.owner_id=c.owner_id)
 ) OR EXISTS (
  SELECT 1 FROM pump_organic_buys t
  LEFT JOIN pump_organic_batches b ON b.id=t.batch_id
  LEFT JOIN pump_organic_sequences s ON s.id=b.sequence_id
  WHERE t.holder=json_extract(selected.value,'$.wallet')
   AND t.state IN ('signed','submitting','submitted')
   AND (t.owner_id=c.owner_id OR b.owner_id=c.owner_id OR s.owner_id=c.owner_id)
 )
) THEN 1 ELSE 0 END`;
