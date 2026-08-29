import { getChatGPTUser } from '@/app/chatgpt-auth';
import { ensurePulseSchema } from '@/db';
import { validateLaunchPlan, type SavedLaunchPlan } from '@/lib/launch-plan';

export const dynamic = 'force-dynamic';

function unauthorized() {
  return Response.json({ error: 'Sign in with ChatGPT to save launch plans.' }, { status: 401 });
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  const db = await ensurePulseSchema();
  const row = await db.prepare(`SELECT chain, launchpad, currency,
    token_name AS tokenName, ticker, description, mode, preset,
    developer_buy AS developerBuy, holders_buy AS holdersBuy,
    holder_count AS holderCount, routing_emphasis AS routingEmphasis,
    use_husher AS useHusher, scheduled,
    simulation_safety AS simulationSafetyJson, updated_at AS updatedAt
    FROM launch_plans WHERE owner_id = ?`)
    .bind(user.userId).first<Omit<SavedLaunchPlan, 'useHusher' | 'scheduled' | 'simulationSafety'> & { useHusher: number; scheduled: number; simulationSafetyJson: string }>();
  if (!row) return Response.json({ plan: null }, { headers: { 'cache-control': 'no-store' } });
  const plan = validateLaunchPlan({
    ...row,
    useHusher: Boolean(row.useHusher),
    scheduled: Boolean(row.scheduled),
    simulationSafety: JSON.parse(row.simulationSafetyJson) as unknown,
  });
  return Response.json({ plan: { ...plan, updatedAt: row.updatedAt } }, {
    headers: { 'cache-control': 'no-store' },
  });
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  try {
    const plan = validateLaunchPlan(await request.json());
    const db = await ensurePulseSchema();
    const updatedAt = new Date().toISOString();
    await db.prepare(`INSERT INTO launch_plans
      (owner_id, chain, launchpad, currency, token_name, ticker, description,
       mode, preset, developer_buy, holders_buy, holder_count, routing_emphasis,
       use_husher, scheduled, simulation_safety, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET
        chain = excluded.chain, launchpad = excluded.launchpad, currency = excluded.currency,
        token_name = excluded.token_name, ticker = excluded.ticker,
        description = excluded.description, mode = excluded.mode, preset = excluded.preset,
        developer_buy = excluded.developer_buy, holders_buy = excluded.holders_buy,
        holder_count = excluded.holder_count, routing_emphasis = excluded.routing_emphasis,
        use_husher = excluded.use_husher, scheduled = excluded.scheduled,
        simulation_safety = excluded.simulation_safety,
        updated_at = excluded.updated_at`)
      .bind(
        user.userId, plan.chain, plan.launchpad, plan.currency, plan.tokenName,
        plan.ticker, plan.description, plan.mode, plan.preset, plan.developerBuy,
        plan.holdersBuy, plan.holderCount, plan.routingEmphasis,
        plan.useHusher ? 1 : 0, plan.scheduled ? 1 : 0,
        JSON.stringify(plan.simulationSafety), updatedAt,
      ).run();
    return Response.json({ plan: { ...plan, updatedAt } }, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Invalid launch plan' }, { status: 400 });
  }
}
