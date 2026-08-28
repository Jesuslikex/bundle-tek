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
