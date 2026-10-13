import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import type { PoolCandles } from '@/lib/pool-candles';
import { acquisitionMint } from '../../../../test/imported-sell-acquisition-fixture';
const mocks = vi.hoisted(() => ({
  db: null as unknown as D1Database,
  observe: vi.fn(),
  user: { userId: 'one' } as { userId: string } | null,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/pool-candles', async (original) => ({
  ...(await original<typeof import('@/lib/pool-candles')>()),
  observePoolCandles: mocks.observe,
}));
import { GET, POST } from './route';
let mf: Miniflare;
const id = '00000000-0000-4000-8000-000000000001',
  address = 'So11111111111111111111111111111111111111112',
  pool = '11111111111111111111111111111111';
const old: PoolCandles = {
  chain: 'Solana',
  address,
  pool,
  interval: '1h',
  source: 'api.geckoterminal.com',
  observedAt: '2026-10-11T10:00:00Z',
  executionAllowed: false,
  candles: [1, 2, 3].map((n) => ({
    time: 1791700000 + n * 3600,
    open: 1,
    high: 2,
    low: 0.5,
    close: 1,
    volume: 10,
  })),
};
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'candle-test',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents: 'export default {fetch(){return new Response("ok")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'candle-follow-test-only' } },
        },
      },
    ],
  });
  mocks.db = await mf.getD1Database('DB', 'candle-test');
  for (const sql of [
    'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,revision INTEGER,archived INTEGER,chain TEXT,address TEXT)',
    'CREATE TABLE imported_pool_candles(owner_id TEXT,project_id TEXT,document TEXT,observed_at TEXT,PRIMARY KEY(owner_id,project_id))',
    'CREATE TABLE imported_market_observations(owner_id TEXT,project_id TEXT,document TEXT)',
    'CREATE TABLE market_read_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
  ])
    await mocks.db.prepare(sql).run();
});
afterAll(async () => mf?.dispose());
beforeEach(async () => {
  mocks.user = { userId: 'one' };
  for (const t of [
    'imported_token_projects',
    'imported_pool_candles',
    'imported_market_observations',
    'market_read_gates',
  ])
    await mocks.db.prepare('DELETE FROM ' + t).run();
  await mocks.db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,1,0,?,?)')
    .bind('one', id, 'Solana', address)
    .run();
  await mocks.db
    .prepare('INSERT INTO imported_pool_candles VALUES(?,?,?,?)')
    .bind('one', id, JSON.stringify([old]), old.observedAt)
    .run();
  await mocks.db
    .prepare('INSERT INTO imported_market_observations VALUES(?,?,?)')
    .bind('one', id, JSON.stringify([{ pairs: [{ address: pool }] }]))
    .run();
  mocks.observe.mockReset().mockResolvedValue({
    ...old,
    observedAt: '2026-10-11T10:01:00Z',
    candles: [{ ...old.candles[2], close: 1.5 }],
  });
});
const post = () =>
  new Request('http://localhost/api/imported-projects/candles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id,
      revision: 1,
      pool,
      interval: '1h',
      mode: 'follow',
    }),
  });
const get = () =>
  new Request(
    `http://localhost/api/imported-projects/candles?id=${id}&revision=1`,
  );
it('retains one-minute observations separately from the existing hourly chart', async () => {
  const minute = {
    ...old,
    interval: '1m' as const,
    observedAt: '2026-10-11T10:01:00Z',
    candles: old.candles.map((c, i) => ({ ...c, time: 1791700020 + i * 60 })),
  };
  mocks.observe.mockResolvedValue(minute);
  const response = await POST(
    new Request('http://localhost/api/imported-projects/candles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, revision: 1, pool, interval: '1m' }),
    }),
  );
  expect(response.status).toBe(200);
  const saved = (await (await GET(get())).json()) as {
    observations: PoolCandles[];
  };
  expect(saved.observations.map((o) => o.interval)).toEqual(['1m', '1h']);
  expect(saved.observations[0].candles).toEqual(minute.candles);
  expect(mocks.observe.mock.calls[0][2]).toBe('1m');
});
it('persists followed prices with older candles and reloads the retained chart', async () => {
  expect((await POST(post())).status).toBe(200);
  const saved = (await (await GET(get())).json()) as {
    observations: PoolCandles[];
  };
  expect(saved.observations[0].candles).toHaveLength(3);
  expect(saved.observations[0].candles[0]).toEqual(old.candles[0]);
  expect(saved.observations[0].candles[2].close).toBe(1.5);
  expect((await POST(post())).status).toBe(429);
});
it('retains prior observations on empty pages and refuses another owner before provider reads', async () => {
  mocks.observe.mockResolvedValue({
    ...old,
    observedAt: '2026-10-11T10:01:00Z',
    candles: [],
  });
  expect((await POST(post())).status).toBe(502);
  expect(
    ((await (await GET(get())).json()) as { observations: PoolCandles[] })
      .observations[0],
  ).toEqual(old);
  mocks.user = { userId: 'other' };
  mocks.observe.mockClear();
  expect((await POST(post())).status).toBe(404);
  expect(mocks.observe).not.toHaveBeenCalled();
});
it('stores and reloads SOL and legacy USD independently and withholds mismatched quote responses', async () => {
  const usd = { ...old, address: acquisitionMint };
  await mocks.db
    .prepare(
      'UPDATE imported_token_projects SET address=? WHERE owner_id=? AND id=?',
    )
    .bind(acquisitionMint, 'one', id)
    .run();
  await mocks.db
    .prepare(
      'UPDATE imported_pool_candles SET document=? WHERE owner_id=? AND project_id=?',
    )
    .bind(JSON.stringify([usd]), 'one', id)
    .run();
  const sol: PoolCandles = {
    ...usd,
    currency: 'sol',
    quoteMint: address,
    observedAt: '2026-10-11T10:01:00Z',
  };
  mocks.observe.mockResolvedValue(sol);
  const selected = () =>
    new Request('http://localhost/api/imported-projects/candles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        revision: 1,
        pool,
        interval: '1h',
        currency: 'sol',
      }),
    });
  expect((await POST(selected())).status).toBe(200);
  expect(mocks.observe.mock.calls[0][6]).toBe('sol');
  const read = (currency?: string) =>
    GET(
      new Request(
        `http://localhost/api/imported-projects/candles?id=${id}&revision=1${currency ? '&currency=' + currency : ''}`,
      ),
    );
  const legacy = (await (await read()).json()) as {
    observations: PoolCandles[];
  };
  expect(legacy.observations).toEqual([usd]);
  const native = (await (await read('sol')).json()) as {
    observations: PoolCandles[];
  };
  expect(native.observations[0].currency).toBe('sol');
  expect(native.observations).toHaveLength(1);
  await mocks.db.prepare('DELETE FROM market_read_gates').run();
  mocks.observe.mockResolvedValue({
    ...sol,
    quoteMint: pool,
    observedAt: '2026-10-11T10:02:00Z',
  });
  expect((await POST(selected())).status).toBe(502);
  expect(
    ((await (await read('sol')).json()) as { observations: PoolCandles[] })
      .observations[0].quoteMint,
  ).toBe(address);
  expect((await read('unknown')).status).toBe(400);
  mocks.user = { userId: 'other' };
  expect((await read('sol')).status).toBe(404);
});
