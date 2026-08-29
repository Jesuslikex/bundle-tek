// Longer than the RPC timeout so a second request cannot overtake an in-flight cycle.
export const CYCLE_THROTTLE_MS = 30_000;
export const CYCLE_RETENTION_DAYS = 30;
export const MAX_RETAINED_CYCLES_PER_OWNER = 100;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

export function requireIdempotencyKey(request: Request) {
  const key = request.headers.get('idempotency-key')?.trim() ?? '';
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new Error('A valid Idempotency-Key header is required.');
  }
  return key;
}

export async function findCompletedCycle(db: D1Database, ownerId: string, key: string) {
  return db.prepare(`SELECT c.id, c.network, c.strategy, c.slot, c.blockhash,
    c.rpc_latency_ms AS rpcLatencyMs, c.planned_orders AS plannedOrders,
    c.projected_turnover AS projectedTurnover, c.risk_score AS riskScore,
    c.status, c.created_at AS createdAt
    FROM pulse_cycle_requests r
    JOIN pulse_cycles c ON c.id = r.cycle_id
    WHERE r.owner_id = ? AND r.idempotency_key = ? AND r.cycle_id IS NOT NULL`)
    .bind(ownerId, key).first();
}

export async function claimCycle(
  db: D1Database,
  ownerId: string,
  key: string,
  now = new Date(),
) {
  const claimedAt = now.toISOString();
  const cutoff = new Date(now.getTime() - CYCLE_THROTTLE_MS).toISOString();
  const result = await db.prepare(`INSERT INTO pulse_cycle_gates
    (owner_id, idempotency_key, claimed_at) VALUES (?, ?, ?)
    ON CONFLICT(owner_id) DO UPDATE SET
      idempotency_key = excluded.idempotency_key,
      claimed_at = excluded.claimed_at
    WHERE pulse_cycle_gates.claimed_at <= ?
    RETURNING owner_id`)
    .bind(ownerId, key, claimedAt, cutoff).first();
  if (!result) return false;

  await db.prepare(`INSERT INTO pulse_cycle_requests
    (owner_id, idempotency_key, claimed_at) VALUES (?, ?, ?)
    ON CONFLICT(owner_id, idempotency_key) DO UPDATE SET
      claimed_at = excluded.claimed_at
    WHERE pulse_cycle_requests.cycle_id IS NULL`)
    .bind(ownerId, key, claimedAt).run();
  return true;
}

export async function releaseCycleClaim(db: D1Database, ownerId: string, key: string) {
  await db.batch([
    db.prepare('DELETE FROM pulse_cycle_requests WHERE owner_id = ? AND idempotency_key = ? AND cycle_id IS NULL').bind(ownerId, key),
    db.prepare('DELETE FROM pulse_cycle_gates WHERE owner_id = ? AND idempotency_key = ?').bind(ownerId, key),
  ]);
}

export function cycleRetentionCutoff(now = new Date()) {
  return new Date(now.getTime() - CYCLE_RETENTION_DAYS * 86_400_000).toISOString();
}
