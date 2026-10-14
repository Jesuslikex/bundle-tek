import { validateHoldersQuoteAmount } from '@/lib/launch-buy';
import { validateSequencedSupply } from '@/lib/launch-supply';
import { validateQuoteSelection } from '@/lib/quote-catalog';
import { validateLaunchMethod } from '@/lib/launch-methods';
import { validateLaunchTiming } from '@/lib/launch-timing';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { ensurePulseSchema } from '@/db';
import { validateLaunchPlan, type SavedLaunchPlan } from '@/lib/launch-plan';

export const dynamic = 'force-dynamic';

function unauthorized() {
  return Response.json(
    { error: 'Sign in to save launch plans.' },
    { status: 401 },
  );
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  const db = await ensurePulseSchema();
  const row = await db
    .prepare(`SELECT chain, launchpad, currency, quote_address AS quoteAddress,
    holders_distribution AS holdersDistributionJson, holders_buy_quote AS holdersBuyQuote, timing AS timingJson, token_name AS tokenName, ticker, description, mode, preset,
    developer_buy AS developerBuy, holders_buy AS holdersBuy,
    holder_count AS holderCount, routing_emphasis AS routingEmphasis,
    use_husher AS useHusher, scheduled,
    simulation_safety AS simulationSafetyJson, updated_at AS updatedAt
    FROM launch_plans WHERE owner_id = ?`)
    .bind(user.userId)
    .first<
      Omit<SavedLaunchPlan, 'useHusher' | 'scheduled' | 'simulationSafety'> & {
        useHusher: number;
        scheduled: number;
        simulationSafetyJson: string;
        timingJson: string | null;
        holdersDistributionJson: string | null;
      }
    >();
  if (!row)
    return Response.json(
      { plan: null },
      { headers: { 'cache-control': 'no-store' } },
    );
  const plan = validateLaunchPlan({
    ...row,
    useHusher: Boolean(row.useHusher),
    scheduled: Boolean(row.scheduled),
    simulationSafety: JSON.parse(row.simulationSafetyJson) as unknown,
    holdersDistribution: row.holdersDistributionJson
      ? (JSON.parse(row.holdersDistributionJson) as unknown)
      : undefined,
    timing: row.timingJson
      ? (JSON.parse(row.timingJson) as unknown)
      : undefined,
  });
  return Response.json(
    { plan: { ...plan, updatedAt: row.updatedAt } },
    {
      headers: { 'cache-control': 'no-store' },
    },
  );
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return unauthorized();
  try {
    const plan = validateLaunchPlan(await request.json());
    validateVenuePlan(plan);
    validateSequencedSupply(plan);
    validateHoldersQuoteAmount(plan);
    validateQuoteSelection(plan);
    validateLaunchMethod(plan);
    validateLaunchTiming(plan);
    const db = await ensurePulseSchema();
    const updatedAt = new Date().toISOString();
    await db
      .prepare(`INSERT INTO launch_plans
      (owner_id, chain, launchpad, currency, quote_address, token_name, ticker, description,
       mode, preset, developer_buy, holders_buy, holder_count, routing_emphasis,
       use_husher, scheduled, simulation_safety, updated_at, timing, holders_buy_quote, holders_distribution)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET
        chain = excluded.chain, launchpad = excluded.launchpad, currency = excluded.currency, quote_address = excluded.quote_address,
        token_name = excluded.token_name, ticker = excluded.ticker,
        description = excluded.description, mode = excluded.mode, preset = excluded.preset,
        developer_buy = excluded.developer_buy, holders_buy = excluded.holders_buy,
        holder_count = excluded.holder_count, routing_emphasis = excluded.routing_emphasis,
        use_husher = excluded.use_husher, scheduled = excluded.scheduled,
        simulation_safety = excluded.simulation_safety,
        timing = excluded.timing,
        holders_buy_quote = excluded.holders_buy_quote,
        holders_distribution = excluded.holders_distribution,
        updated_at = excluded.updated_at`)
      .bind(
        user.userId,
        plan.chain,
        plan.launchpad,
        plan.currency,
        plan.quoteAddress ?? null,
        plan.tokenName,
        plan.ticker,
        plan.description,
        plan.mode,
        plan.preset,
        plan.developerBuy,
        plan.holdersBuy,
        plan.holderCount,
        plan.routingEmphasis,
        plan.useHusher ? 1 : 0,
        plan.scheduled ? 1 : 0,
        JSON.stringify(plan.simulationSafety),
        updatedAt,
        plan.timing ? JSON.stringify(plan.timing) : null,
        plan.holdersBuyQuote ?? null,
        plan.holdersDistribution
          ? JSON.stringify(plan.holdersDistribution)
          : null,
      )
      .run();
    return Response.json(
      { plan: { ...plan, updatedAt } },
      {
        headers: { 'cache-control': 'no-store' },
      },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Invalid launch plan' },
      { status: 400 },
    );
  }
}
import { validateVenuePlan } from '@/lib/venue-limits';
