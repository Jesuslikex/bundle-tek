import { getChatGPTUser } from '@/app/chatgpt-auth';
import { ensurePulseSchema } from '@/db';
import { projectPulseCycle, type PulseStrategyInput } from '@/lib/pulse-validation';
import { getSolanaSnapshot } from '@/lib/solana-rpc';
import {
  claimCycle,
  CYCLE_THROTTLE_MS,
  cycleRetentionCutoff,
  findCompletedCycle,
  MAX_RETAINED_CYCLES_PER_OWNER,
  releaseCycleClaim,
  requireIdempotencyKey,
} from '@/lib/pulse-cycle-control';

export const dynamic = 'force-dynamic';

function unauthorized() {
  return Response.json({ error: 'Sign in with ChatGPT to control the backend.' }, { status: 401 });
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  const db = await ensurePulseSchema();
  const result = await db.prepare(`SELECT id, network, strategy, slot, blockhash,
    rpc_latency_ms AS rpcLatencyMs, planned_orders AS plannedOrders,
    projected_turnover AS projectedTurnover, risk_score AS riskScore,
    status, created_at AS createdAt
    FROM pulse_cycles WHERE owner_id = ? ORDER BY created_at DESC LIMIT 12`)
    .bind(user.userId).all();
  return Response.json({ cycles: result.results });
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  let idempotencyKey: string | undefined;
  try {
    idempotencyKey = requireIdempotencyKey(request);
    const db = await ensurePulseSchema();
    const completed = await findCompletedCycle(db, user.userId, idempotencyKey);
    if (completed) {
      return Response.json({ cycle: completed, signing: 'locked', submittedTransactions: 0 }, {
        headers: { 'idempotency-replayed': 'true' },
      });
    }
    if (!await claimCycle(db, user.userId, idempotencyKey)) {
      return Response.json({ error: 'A cycle is already running or was started too recently.' }, {
        status: 429,
        headers: { 'retry-after': String(Math.ceil(CYCLE_THROTTLE_MS / 1000)) },
      });
    }
    const row = await db.prepare(`SELECT strategy, agents, budget, cadence,
      order_size AS orderSize, spread, inventory
      FROM pulse_strategies WHERE owner_id = ?`).bind(user.userId).first<PulseStrategyInput>();
    if (!row) {
      await releaseCycleClaim(db, user.userId, idempotencyKey);
      return Response.json({ error: 'Save a strategy first.' }, { status: 404 });
    }
    const snapshot = await getSolanaSnapshot('mainnet');
    const projection = projectPulseCycle(row);
    const cycle = {
      id: crypto.randomUUID(), network: 'mainnet-readonly', strategy: row.strategy,
      slot: snapshot.slot, blockhash: snapshot.blockhash, rpcLatencyMs: snapshot.latencyMs,
      plannedOrders: projection.orders, projectedTurnover: projection.turnover,
      riskScore: projection.risk, status: 'SIMULATED', createdAt: new Date().toISOString(),
    };
    await db.batch([
      db.prepare(`INSERT INTO pulse_cycles
        (id, owner_id, network, strategy, slot, blockhash, rpc_latency_ms,
         planned_orders, projected_turnover, risk_score, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(cycle.id, user.userId, cycle.network, cycle.strategy, cycle.slot, cycle.blockhash,
          cycle.rpcLatencyMs, cycle.plannedOrders, cycle.projectedTurnover, cycle.riskScore,
          cycle.status, cycle.createdAt),
      db.prepare(`UPDATE pulse_cycle_requests SET cycle_id = ?, completed_at = ?
        WHERE owner_id = ? AND idempotency_key = ?`)
        .bind(cycle.id, cycle.createdAt, user.userId, idempotencyKey),
      db.prepare(`DELETE FROM pulse_cycles WHERE owner_id = ? AND (
        created_at < ? OR id NOT IN (
          SELECT id FROM pulse_cycles WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?
        ))`)
        .bind(user.userId, cycleRetentionCutoff(), user.userId, MAX_RETAINED_CYCLES_PER_OWNER),
      db.prepare('DELETE FROM pulse_cycle_requests WHERE claimed_at < ?')
        .bind(cycleRetentionCutoff()),
    ]);
    return Response.json({ cycle, signing: 'locked', submittedTransactions: 0 });
  } catch (error) {
    if (idempotencyKey) {
      try {
        const db = await ensurePulseSchema();
        await releaseCycleClaim(db, user.userId, idempotencyKey);
      } catch {
        // Preserve the original failure; a stale claim naturally expires at the throttle cutoff.
      }
    }
    if (error instanceof Error && error.message.includes('Idempotency-Key')) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: error instanceof Error ? error.message : 'Cycle failed' }, { status: 502 });
  }
}
