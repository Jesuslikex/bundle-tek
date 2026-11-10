// Market Overview for the status bar, like Proxima's bottom bar: DEX volume by
// network, launchpads ranked by volume and a trench heat score.
// Public DefiLlama data, read-only, shared by everyone through one cached read.
// Display only: never used for quotes, sizing or any transaction.
import {
  OVERVIEW_NETWORKS,
  parseOverviewNetwork,
  type MarketOverview,
  type OverviewNetwork,
  type OverviewNetworkId,
} from '@/lib/market-overview';

export const dynamic = 'force-dynamic';
const CACHE_MS = 5 * 60_000;
const STALE_MS = 60 * 60_000;
const TIMEOUT_MS = 12_000;
const SOURCE = 'https://api.llama.fi/overview/dexs';
const QUERY = '?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true';

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

let cached: { at: number; body: MarketOverview } | null = null;
let inflight: Promise<MarketOverview | null> | null = null;

async function read(id: OverviewNetworkId, slug: string) {
  try {
    const response = await fetch(`${SOURCE}${slug && '/' + slug}${QUERY}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    return parseOverviewNetwork(id, await response.json());
  } catch {
    return null;
  }
}

async function load(): Promise<MarketOverview | null> {
  const results = await Promise.all([
    read('All', ''),
    ...OVERVIEW_NETWORKS.map(([id, slug]) => read(id, slug)),
  ]);
  const networks = results.filter((n): n is OverviewNetwork => n !== null);
  // Without the all-network total the panel has no headline; treat as down.
  return networks.some((n) => n.id === 'All')
    ? { observedAt: new Date().toISOString(), source: 'DefiLlama', networks }
    : null;
}

export async function GET() {
  if (cached && Date.now() - cached.at < CACHE_MS) return json(cached.body);
  inflight ??= load()
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  const body = await inflight;
  if (!body) {
    // Keep showing the last good overview for a while rather than going blank.
    if (cached && Date.now() - cached.at < STALE_MS) return json(cached.body);
    return json({ error: 'Market overview is unavailable right now.' }, 503);
  }
  cached = { at: Date.now(), body };
  return json(body);
}
