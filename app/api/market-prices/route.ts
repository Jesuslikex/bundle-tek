// SOL, BNB and ETH reference prices for the status bar, like Proxima's footer.
// Public CoinGecko data, read-only, shared by everyone through one cached read.
// Display only: never used for quotes, sizing or any transaction.
export const dynamic = 'force-dynamic';
const CACHE_MS = 60_000;
const TIMEOUT_MS = 6_000;
const SOURCE =
  'https://api.coingecko.com/api/v3/simple/price?ids=solana,binancecoin,ethereum&vs_currencies=usd&include_24hr_change=true';
const ASSETS = [
  ['SOL', 'solana'],
  ['BNB', 'binancecoin'],
  ['ETH', 'ethereum'],
] as const;

export type MarketPrice = {
  symbol: string;
  usd: number;
  change24h: number | null;
};
export type MarketPrices = { observedAt: string; prices: MarketPrice[] };

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

let cached: { at: number; body: MarketPrices } | null = null;
let inflight: Promise<MarketPrices | null> | null = null;

function finite(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function load(): Promise<MarketPrices | null> {
  const response = await fetch(SOURCE, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) return null;
  const raw = (await response.json()) as Record<
    string,
    Record<string, unknown>
  >;
  const prices: MarketPrice[] = [];
  for (const [symbol, id] of ASSETS) {
    const usd = finite(raw?.[id]?.usd);
    if (usd === null || usd <= 0) continue;
    prices.push({ symbol, usd, change24h: finite(raw[id].usd_24h_change) });
  }
  return prices.length
    ? { observedAt: new Date().toISOString(), prices }
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
    // Keep showing the last good prices for a while rather than going blank.
    if (cached && Date.now() - cached.at < 10 * CACHE_MS)
      return json(cached.body);
    return json({ error: 'Prices are unavailable right now.' }, 503);
  }
  cached = { at: Date.now(), body };
  return json(body);
}
