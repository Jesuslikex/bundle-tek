import { getChatGPTUser } from '@/app/chatgpt-auth';
import { ensurePulseSchema } from '@/db';
import { validatePulseStrategy } from '@/lib/pulse-validation';

export const dynamic = 'force-dynamic';

function unauthorized() {
  return Response.json({ error: 'Sign in with ChatGPT to control the backend.' }, { status: 401 });
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  const db = await ensurePulseSchema();
  const strategy = await db.prepare(`SELECT strategy, agents, budget, cadence, order_size AS orderSize,
    spread, inventory, active, network, updated_at AS updatedAt
    FROM pulse_strategies WHERE owner_id = ?`).bind(user.userId).first();
  return Response.json({ strategy: strategy ?? null, user: { email: user.email } });
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  try {
    const input = validatePulseStrategy(await request.json());
    const db = await ensurePulseSchema();
    const updatedAt = new Date().toISOString();
    await db.prepare(`INSERT INTO pulse_strategies
      (owner_id, strategy, agents, budget, cadence, order_size, spread, inventory, active, network, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'mainnet-readonly', ?)
      ON CONFLICT(owner_id) DO UPDATE SET
        strategy = excluded.strategy, agents = excluded.agents, budget = excluded.budget,
        cadence = excluded.cadence, order_size = excluded.order_size, spread = excluded.spread,
        inventory = excluded.inventory, updated_at = excluded.updated_at`)
      .bind(user.userId, input.strategy, input.agents, input.budget, input.cadence, input.orderSize, input.spread, input.inventory, updatedAt).run();
    return Response.json({ saved: true, updatedAt, mode: 'simulation-only' });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Invalid request' }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  const body = await request.json() as { active?: unknown };
  if (typeof body.active !== 'boolean') return Response.json({ error: 'active must be boolean' }, { status: 400 });
  const db = await ensurePulseSchema();
  const result = await db.prepare('UPDATE pulse_strategies SET active = ?, updated_at = ? WHERE owner_id = ?')
    .bind(body.active ? 1 : 0, new Date().toISOString(), user.userId).run();
  if (!result.meta.changes) return Response.json({ error: 'Save a strategy first.' }, { status: 404 });
  return Response.json({ active: body.active, signing: 'locked' });
}
