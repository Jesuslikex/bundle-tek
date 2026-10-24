import { afterEach, expect, it, vi } from 'vitest';
import {
  ownedJitoSequentialFixture,
  closeOwnedJitoSequentialFixtures,
} from './jito-sequential-check-owned-fixture';
import { requireJitoSequentialCheckResult } from '../lib/jito-sequential-check-result';
const context = vi.hoisted(() => ({
  db: null as unknown as D1Database,
  owner: 'owner',
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => ({ userId: context.owner }),
}));
vi.mock('@/db', () => ({ getD1: () => context.db }));
import { POST } from '../app/api/imported-projects/jito-bundles/route';
afterEach(() => {
  closeOwnedJitoSequentialFixtures();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  context.owner = 'owner';
});
async function setup() {
  const fixture = await ownedJitoSequentialFixture({
    side: 'Buy',
    lookup: true,
    token2022: true,
    wallets: 2,
  });
  fixture.d.sqlite.exec(
    'CREATE TABLE wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER NOT NULL)',
  );
  context.db = fixture.d.db;
  vi.stubGlobal('fetch', fixture.dependencies.fetcher);
  const request = () =>
    new Request('http://localhost/api/imported-projects/jito-bundles', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify({ action: 'check-sequential', ...fixture.input }),
    });
  return { ...fixture, request };
}
it('composes actual authenticated route, owned SQL, raw RPC collector and the client DTO without modifying the bundle', async () => {
  const x = await setup();
  const before = x.d.sqlite.prepare('SELECT * FROM jito_bundles').all();
  const packets = x.d.sqlite.prepare('SELECT * FROM jito_bundle_packets').all();
  const response = await POST(x.request());
  expect(response.status).toBe(200);
  const body = (await response.json()) as { sequentialCheck: unknown };
  const result = requireJitoSequentialCheckResult(
    body.sequentialCheck,
    x.f.fixture.manifest,
  );
  expect(result).toMatchObject({
    status: 'frames-observed',
    packetCount: 3,
    minimumSlot: 100,
    simulationSlot: 101,
    signingAllowed: false,
    executionAllowed: false,
    providerQualified: false,
  });
  expect(Object.keys(body)).toEqual(['sequentialCheck']);
  const publicText = JSON.stringify(body);
  expect(publicText.length).toBeLessThan(4096);
  expect(publicText).not.toContain(x.f.fixture.manifest.swaps[0].transaction);
  expect(publicText).not.toContain('rawResponse');
  expect(publicText).not.toContain('https://');
  expect(
    x.calls.every((method) =>
      [
        'getGenesisHash',
        'getMultipleAccounts',
        'fees',
        'simulateBundle',
      ].includes(method),
    ),
  ).toBe(true);
  expect(x.calls.filter((method) => method === 'simulateBundle')).toHaveLength(
    1,
  );
  expect(x.d.sqlite.prepare('SELECT * FROM jito_bundles').all()).toEqual(
    before,
  );
  expect(x.d.sqlite.prepare('SELECT * FROM jito_bundle_packets').all()).toEqual(
    packets,
  );
  expect(
    x.d.sqlite.prepare('SELECT COUNT(*) AS n FROM wallet_balance_gates').get(),
  ).toEqual({ n: 1 });
});
it('rejects a different authenticated owner before any provider read', async () => {
  const x = await setup();
  context.owner = 'other';
  const response = await POST(x.request());
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: 'Sequential check context changed or unavailable.',
  });
  expect(x.calls).toEqual([]);
});
it('discards the result if the actual control row changes during simulation', async () => {
  const x = await setup();
  x.setHook((method) => {
    if (method === 'simulateBundle')
      x.d.sqlite
        .prepare(
          "UPDATE imported_trade_session_controls SET state='paused',revision=revision+1",
        )
        .run();
  });
  const response = await POST(x.request());
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: 'Sequential check context changed or unavailable.',
  });
  expect(x.d.sqlite.prepare('SELECT state FROM jito_bundles').get()).toEqual({
    state: 'reviewed',
  });
});
it('keeps a provider 429 as a bounded refusal and performs no subsequent reads', async () => {
  const x = await setup();
  x.setStatus('fees', 429);
  const response = await POST(x.request());
  expect(response.status).toBe(200);
  const body = (await response.json()) as { sequentialCheck: unknown };
  expect(
    requireJitoSequentialCheckResult(
      body.sequentialCheck,
      x.f.fixture.manifest,
    ),
  ).toMatchObject({
    status: 'refused',
    reason: 'rate-limited',
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(x.calls.at(-1)).toBe('fees');
  expect(x.calls).not.toContain('simulateBundle');
});
