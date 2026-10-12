import { env } from 'cloudflare:workers';

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS pulse_strategies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    strategy TEXT NOT NULL,
    agents INTEGER NOT NULL,
    budget REAL NOT NULL,
    cadence INTEGER NOT NULL,
    order_size REAL NOT NULL,
    spread INTEGER NOT NULL,
    inventory INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    network TEXT NOT NULL DEFAULT 'devnet',
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_pulse_strategies_owner
    ON pulse_strategies(owner_id)`,
  `CREATE TABLE IF NOT EXISTS pulse_cycles (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    network TEXT NOT NULL,
    strategy TEXT NOT NULL,
    slot INTEGER NOT NULL,
    blockhash TEXT NOT NULL,
    rpc_latency_ms INTEGER NOT NULL,
    planned_orders INTEGER NOT NULL,
    projected_turnover REAL NOT NULL,
    risk_score INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pulse_cycles_owner_created
    ON pulse_cycles(owner_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS pulse_cycle_gates (
    owner_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL,
    claimed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pulse_cycle_requests (
    owner_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    cycle_id TEXT,
    claimed_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_pulse_cycle_requests_owner_key
    ON pulse_cycle_requests(owner_id, idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS idx_pulse_cycle_requests_claimed
    ON pulse_cycle_requests(claimed_at)`,
  `CREATE TABLE IF NOT EXISTS launch_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    chain TEXT NOT NULL,
    launchpad TEXT NOT NULL,
    currency TEXT NOT NULL,
    quote_address TEXT,
    timing TEXT,
    holders_buy_quote TEXT,
    holders_distribution TEXT,
    token_name TEXT NOT NULL,
    ticker TEXT NOT NULL,
    description TEXT NOT NULL,
    mode TEXT NOT NULL,
    preset TEXT NOT NULL,
    developer_buy REAL NOT NULL,
    holders_buy REAL NOT NULL,
    holder_count INTEGER NOT NULL,
    routing_emphasis INTEGER NOT NULL,
    use_husher INTEGER NOT NULL DEFAULT 0,
    scheduled INTEGER NOT NULL DEFAULT 0,
    simulation_safety TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_launch_plans_owner
    ON launch_plans(owner_id)`,
  `CREATE TABLE IF NOT EXISTS wallet_challenges (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT '',
    claim_nonce TEXT,
    wallet_address TEXT NOT NULL,
    message TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wallet_challenges_address_expires
    ON wallet_challenges(wallet_address, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_wallet_challenges_owner_address
    ON wallet_challenges(owner_id, wallet_address, expires_at)`,
  `CREATE TABLE IF NOT EXISTS wallet_audit_events (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL DEFAULT '',
    wallet_address TEXT NOT NULL,
    network TEXT NOT NULL DEFAULT 'devnet',
    event_type TEXT NOT NULL,
    transaction_signature TEXT,
    details TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wallet_audit_address_created
    ON wallet_audit_events(wallet_address, created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_audit_owner_transaction
    ON wallet_audit_events(owner_id, transaction_signature)`,
  `CREATE INDEX IF NOT EXISTS idx_wallet_audit_owner_created
    ON wallet_audit_events(owner_id, created_at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS wallet_receipt_gates (owner_id TEXT PRIMARY KEY NOT NULL, claimed_at INTEGER NOT NULL)`,
];

export function getD1(): D1Database {
  if (!env.DB) throw new Error('D1 binding DB is unavailable');
  return env.DB;
}

export async function ensurePulseSchema() {
  const db = getD1();
  await db.batch(schemaStatements.map((statement) => db.prepare(statement)));
  return db;
}
