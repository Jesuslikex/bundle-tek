import { beforeEach, expect, it, vi } from 'vitest';
import type { MarketOverview } from '@/lib/market-overview';

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});
const load = async () => (await import('./route')).GET;
const upstream = (total: number) => ({
  total24h: total,
  total7d: total * 7,
  total30d: total * 30,
  totalAllTime: total * 1000,
  change_1d: 1,
  protocols: [
    {
      name: 'pump.fun',
      category: 'Launchpad',
      chains: ['Solana'],
      total24h: 10,
      total30d: 300,
    },
  ],
});

it('reads all networks once, then serves the cache', async () => {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    urls.push(url);
    return Response.json(upstream(url.includes('/solana') ? 500 : 100));
  });
  vi.stubGlobal('fetch', fetchMock);
  const GET = await load();
  const response = await GET();
  expect(response.status).toBe(200);
  const body = (await response.json()) as MarketOverview;
  expect(body.source).toBe('DefiLlama');
  expect(body.networks.map((n) => n.id)).toEqual([
    'All',
    'Solana',
    'Base',
    'BNB',
    'Ethereum',
  ]);
  expect(body.networks[1].volume['24h']).toBe(500);
  expect(body.networks[1].trench).toEqual({ score: 50, label: 'Neutral' });
  expect(urls[0]).toMatch(/\/overview\/dexs\?excludeTotalDataChart=true/);
  expect(urls).toContainEqual(expect.stringContaining('/overview/dexs/bsc?'));
  await GET();
  expect(fetchMock).toHaveBeenCalledTimes(5);
});

it('keeps the networks that answered when one chain fails', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('/base')
        ? new Response('', { status: 500 })
        : Response.json(upstream(100)),
    ),
  );
  const body = (await (await (await load())()).json()) as MarketOverview;
  expect(body.networks.map((n) => n.id)).toEqual([
    'All',
    'Solana',
    'BNB',
    'Ethereum',
  ]);
});

it('answers 503 when the overall total is unavailable', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('down');
    }),
  );
  const response = await (await load())();
  expect(response.status).toBe(503);
});
