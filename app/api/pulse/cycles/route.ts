import { getChatGPTUser } from '@/app/chatgpt-auth';
import { ensurePulseSchema } from '@/db';
import { projectPulseCycle, type PulseStrategyInput } from '@/lib/pulse-validation';
import { getSolanaSnapshot } from '@/lib/solana-rpc';

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

export async function POST() {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  try {
    const db = await ensurePulseSchema();
    const row = await db.prepare(`SELECT strategy, agents, budget, cadence,
      order_size AS orderSize, spread, inventory
      FROM pulse_strategies WHERE owner_id = ?`).bind(user.userId).first<PulseStrategyInput>();
    if (!row) return Response.json({ error: 'Save a strategy first.' }, { status: 404 });
    const snapshot = await getSolanaSnapshot('mainnet');
    const projection = projectPulseCycle(row);
    const cycle = {
      id: crypto.randomUUID(), network: 'mainnet-readonly', strategy: row.strategy,
      slot: snapshot.slot, blockhash: snapshot.blockhash, rpcLatencyMs: snapshot.latencyMs,
      plannedOrders: projection.orders, projectedTurnover: projection.turnover,
      riskScore: projection.risk, status: 'SIMULATED', createdAt: new Date().toISOString(),
    };
    await db.prepare(`INSERT INTO pulse_cycles
      (id, owner_id, network, strategy, slot, blockhash, rpc_latency_ms,
       planned_orders, projected_turnover, risk_score, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(cycle.id, user.userId, cycle.network, cycle.strategy, cycle.slot, cycle.blockhash,
        cycle.rpcLatencyMs, cycle.plannedOrders, cycle.projectedTurnover, cycle.riskScore,
        cycle.status, cycle.createdAt).run();
    return Response.json({ cycle, signing: 'locked', submittedTransactions: 0 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Cycle failed' }, { status: 502 });
  }
}
