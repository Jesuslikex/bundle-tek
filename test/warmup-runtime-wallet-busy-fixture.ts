/** Minimal read-side parent projections, not a proof of their signing lifecycles. */
export async function installWarmupRuntimeWalletParents(db: D1Database) {
  for (const sql of WARMUP_RUNTIME_PARENT_FIXTURE_SQL)
    await db.prepare(sql).run();
}
export const WARMUP_RUNTIME_PARENT_FIXTURE_SQL = [
  'CREATE TABLE IF NOT EXISTS pair_order_executions(owner_id TEXT,wallet TEXT,state TEXT)',
  'CREATE TABLE IF NOT EXISTS pump_launch_reviews(owner_id TEXT,payer TEXT,state TEXT,review TEXT)',
  'CREATE TABLE IF NOT EXISTS volume_bot_sessions(owner_id TEXT,state TEXT,plan TEXT,id TEXT)',
  'CREATE TABLE IF NOT EXISTS volume_bundle_reservations(owner_id TEXT,wallet TEXT,state TEXT,expires_at TEXT)',
  'CREATE TABLE IF NOT EXISTS volume_bot_batches(id TEXT,session_id TEXT)',
  'CREATE TABLE IF NOT EXISTS volume_bot_trades(batch_id TEXT,state TEXT)',
  'CREATE TABLE IF NOT EXISTS pump_organic_sequences(owner_id TEXT,state TEXT,plan TEXT,id TEXT)',
  'CREATE TABLE IF NOT EXISTS pump_organic_batches(id TEXT,sequence_id TEXT)',
  'CREATE TABLE IF NOT EXISTS pump_organic_buys(batch_id TEXT,state TEXT)',
  'CREATE TABLE IF NOT EXISTS wallet_cleanups(owner_id TEXT,wallet_address TEXT,state TEXT)',
  'CREATE TABLE IF NOT EXISTS token_supply_actions(owner_id TEXT,wallet_address TEXT,state TEXT)',
  'CREATE TABLE IF NOT EXISTS sniper_nuke_sells(owner_id TEXT,wallet TEXT,state TEXT)',
  'CREATE TABLE IF NOT EXISTS counter_proposal_reservations(owner_id TEXT,wallet_address TEXT,approval_id TEXT,expires_at TEXT)',
];
