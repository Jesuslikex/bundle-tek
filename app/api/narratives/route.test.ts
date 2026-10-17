import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: null as { userId: string; email: string } | null,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));

const MINT = 'So11111111111111111111111111111111111111112';
const pump = [
  { mint: MINT, name: 'Pepe Max', symbol: 'PMAX' },
  { mint: MINT.replace('2', '3'), name: 'Pepe Mini', symbol: 'PMINI' },
];

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  mocks.user = { userId: 'u1', email: 'u1@example.test' };
});
const load = async () => (await import('./route')).GET;
const get = (GET: (r: Request) => Promise<Response>, q = '') =>
  GET(new Request(`http://localhost/api/narratives${q}`));

it('requires sign-in', async () => {
  mocks.user = null;
  expect((await get(await load())).status).toBe(401);
});

it('ranks narratives and serves repeat visits from the cache', async () => {
  const fetchMock = vi.fn(async (input: string | URL) =>
    String(input).includes('pump.fun')
      ? Response.json(pump)
      : new Response('', { status: 500 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const GET = await load();
  const response = await get(GET);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { narratives: { keyword: string }[] };
  expect(body.narratives.map((n) => n.keyword)).toEqual(['pepe']);
  const calls = fetchMock.mock.calls.length;
  expect((await get(GET, '?refresh=1')).status).toBe(200);
  expect(fetchMock.mock.calls.length).toBe(calls);
});

it('reports 503 when every feed fails', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 500 })),
  );
  expect((await get(await load())).status).toBe(503);
});
