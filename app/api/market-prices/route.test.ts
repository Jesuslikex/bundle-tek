import { beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});
const load = async () => (await import('./route')).GET;

const upstream = {
  solana: { usd: 182.4, usd_24h_change: 2.5 },
  binancecoin: { usd: 731.2, usd_24h_change: -0.4 },
  ethereum: { usd: 2451, usd_24h_change: null },
};

it('returns SOL, BNB and ETH and serves repeats from the cache', async () => {
  const fetchMock = vi.fn(async () => Response.json(upstream));
  vi.stubGlobal('fetch', fetchMock);
  const GET = await load();
  const response = await GET();
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    prices: { symbol: string; usd: number; change24h: number | null }[];
  };
  expect(body.prices).toEqual([
    { symbol: 'SOL', usd: 182.4, change24h: 2.5 },
    { symbol: 'BNB', usd: 731.2, change24h: -0.4 },
    { symbol: 'ETH', usd: 2451, change24h: null },
  ]);
  await GET();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('drops malformed entries', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        solana: { usd: 'x' },
        ethereum: { usd: -1 },
        binancecoin: { usd: 700 },
      }),
    ),
  );
  const body = (await (await (await load())()).json()) as {
    prices: { symbol: string }[];
  };
  expect(body.prices.map((p) => p.symbol)).toEqual(['BNB']);
});

it('reports 503 when the source fails and nothing is cached', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 429 })),
  );
  expect((await (await load())()).status).toBe(503);
});

it('reports 503 when the source throws', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network');
    }),
  );
  expect((await (await load())()).status).toBe(503);
});
