import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { createTursoDatabase } from '@/db/turso';
import { defaultTradeAmountPresets } from '@/lib/trade-amount-preferences';
import { GET, POST } from './route';
const state = vi.hoisted(() => ({
  owner: 'alice' as string | null,
  db: null as D1Database | null,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => (state.owner ? { userId: state.owner } : null),
}));
vi.mock('@/db', () => ({ getD1: () => state.db }));
let client: ReturnType<typeof createClient>;
const request = (body: unknown, origin = 'https://bundle.test') =>
  new Request('https://bundle.test/api/trade-amount-preferences', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(
      body && typeof body === 'object'
        ? { ownerId: state.owner, ...body }
        : body,
    ),
  });
const get = () =>
  GET(new Request('https://bundle.test/api/trade-amount-preferences'));
beforeEach(async () => {
  client = createClient({ url: 'file::memory:' });
  state.db = createTursoDatabase(client);
  state.owner = 'alice';
  for (const sql of readFileSync(
    'drizzle/0111_trade_amount_preferences.sql',
    'utf8',
  ).split('--> statement-breakpoint'))
    if (sql.trim()) await client.execute(sql);
});
afterEach(() => client.close());
it('returns unsaved defaults without inserting rows, persists owner preferences and reloads exact terms', async () => {
  const initial = await get();
  expect(initial.headers.get('cache-control')).toBe('no-store');
  expect(await initial.json()).toMatchObject({
    revision: 0,
    preferences: defaultTradeAmountPresets(),
  });
  expect(
    (await client.execute('SELECT count(*) n FROM trade_amount_preferences'))
      .rows[0].n,
  ).toBe(0);
  const preferences = {
    ...defaultTradeAmountPresets(),
    buySol: ['0.025', '0.1'],
    sellBalanceBps: [1250, 3333, 10000],
  };
  expect(
    await (await POST(request({ revision: 0, preferences }))).json(),
  ).toMatchObject({ ownerId: 'alice', revision: 1, preferences });
  expect(await (await get()).json()).toMatchObject({
    revision: 1,
    preferences,
  });
  state.owner = 'bob';
  expect(await (await get()).json()).toMatchObject({
    revision: 0,
    preferences: defaultTradeAmountPresets(),
  });
});
it('admits exactly one concurrent save and refuses stale overwrites', async () => {
  const preferences = defaultTradeAmountPresets();
  const results = await Promise.all([
    POST(request({ revision: 0, preferences })),
    POST(
      request({
        revision: 0,
        preferences: { ...preferences, buySol: ['0.02'] },
      }),
    ),
  ]);
  expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
    200, 409,
  ]);
  expect((await POST(request({ revision: 0, preferences }))).status).toBe(409);
  expect((await POST(request({ revision: 1, preferences }))).status).toBe(200);
  expect(await (await get()).json()).toMatchObject({ revision: 2 });
});
it('authenticates before storage, rejects cross-origin and malformed settings, and never accepts executable fields', async () => {
  state.owner = null;
  expect((await get()).status).toBe(401);
  expect((await POST(request({}))).status).toBe(401);
  state.owner = 'alice';
  for (const body of [
    { revision: 0, preferences: defaultTradeAmountPresets(), userId: 'bob' },
    {
      revision: 0,
      preferences: { ...defaultTradeAmountPresets(), transaction: 'unused' },
    },
    { revision: -1, preferences: defaultTradeAmountPresets() },
  ])
    expect((await POST(request(body))).status).toBe(400);
  expect(
    (
      await POST(
        request(
          { revision: 0, preferences: defaultTradeAmountPresets() },
          'https://evil.example',
        ),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await GET(
        new Request(
          'https://bundle.test/api/trade-amount-preferences?owner=bob',
        ),
      )
    ).status,
  ).toBe(400);
  expect(
    (await client.execute('SELECT count(*) n FROM trade_amount_preferences'))
      .rows[0].n,
  ).toBe(0);
});
it('refuses a save when cookies now identify a different account than the editor', async () => {
  const response = await POST(
    request({
      ownerId: 'bob',
      revision: 0,
      preferences: defaultTradeAmountPresets(),
    }),
  );
  expect(response.status).toBe(409);
  expect(
    (await client.execute('SELECT count(*) n FROM trade_amount_preferences'))
      .rows[0].n,
  ).toBe(0);
});
it('keeps preferences unchanged if a write is rejected, and supports explicit reset through a new revision', async () => {
  const defaults = defaultTradeAmountPresets();
  await POST(
    request({ revision: 0, preferences: { ...defaults, buySol: ['0.2'] } }),
  );
  await client.execute(
    "CREATE TRIGGER refuse_prefs BEFORE UPDATE ON trade_amount_preferences BEGIN SELECT RAISE(ABORT,'fixture write refusal');END",
  );
  expect(
    (await POST(request({ revision: 1, preferences: defaults }))).status,
  ).toBe(503);
  expect(await (await get()).json()).toMatchObject({
    revision: 1,
    preferences: { buySol: ['0.2'] },
  });
  await client.execute('DROP TRIGGER refuse_prefs');
  expect(
    await (await POST(request({ revision: 1, preferences: defaults }))).json(),
  ).toMatchObject({ revision: 2, preferences: defaults });
  await expect(
    client.execute('DELETE FROM trade_amount_preferences'),
  ).rejects.toThrow();
});
