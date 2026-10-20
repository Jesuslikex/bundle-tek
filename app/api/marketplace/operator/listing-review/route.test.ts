import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { marketplaceOwnedFixture } from '@/test/marketplace-owned-fixture';
const mocks = vi.hoisted(() => ({
  user: { userId: 'operator' } as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { POST } from './route';
import { GET } from '../inventory/route';
let calls: { sql: string; values: unknown[] }[],
  batch: ReturnType<typeof vi.fn>,
  fixture: ReturnType<typeof marketplaceOwnedFixture>;
beforeEach(() => {
  vi.stubEnv('MARKETPLACE_OPERATOR_USER_IDS', '["operator"]');
  mocks.user = { userId: 'operator' };
  fixture = marketplaceOwnedFixture();
  calls = [];
  batch = vi.fn(async () =>
    [
      fixture.sources.wallets,
      fixture.sources.proofs,
      fixture.sources.runs,
      fixture.sources.receipts,
    ].map((results) => ({ results })),
  );
  mocks.db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          calls.push({ sql, values });
          return {};
        },
      };
    },
    batch,
  } as unknown as D1Database;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No network allowed');
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function post(
  body: unknown = {
    address: fixture.a,
    walletRevision: 2,
    priceLamports: '50000000',
  },
  headers: Record<string, string> = {
    origin: 'http://localhost',
    'content-type': 'application/json',
  },
  signal?: AbortSignal,
) {
  return POST(
    new Request('http://localhost/api/marketplace/operator/listing-review', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal,
    }),
  );
}
const get = () =>
  GET(new Request('http://localhost/api/marketplace/operator/inventory'));
it('requires a verified session before either seller operation', async () => {
  mocks.user = null;
  expect((await get()).status).toBe(401);
  expect((await post()).status).toBe(401);
  expect(calls).toEqual([]);
});
it('denies buyers even when headers and request claims pretend they are operators', async () => {
  mocks.user = { userId: 'buyer' };
  expect((await get()).status).toBe(403);
  expect(
    (
      await post(
        { operator: true },
        {
          origin: 'http://localhost',
          'content-type': 'application/json',
          'x-operator': 'true',
        },
      )
    ).status,
  ).toBe(403);
  expect(calls).toEqual([]);
});
it('fails closed for absent or malformed server policy without looking up inventory', async () => {
  for (const policy of ['', '*', '["operator","operator"]']) {
    vi.stubEnv('MARKETPLACE_OPERATOR_USER_IDS', policy);
    expect((await get()).status).toBe(403);
    expect((await post()).status).toBe(403);
  }
  expect(calls).toEqual([]);
});
it('loads only the configured operator’s inventory through SELECTs', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(calls).toHaveLength(4);
  expect(
    calls.every(
      (call) =>
        call.sql.startsWith('SELECT') &&
        call.values.every((value) => value === 'operator'),
    ),
  ).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it('reviews exact owned prices without a write or publication capability', async () => {
  const response = await post();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    sellerModel: 'bundle-operated',
    selection: {
      address: fixture.a,
      walletRevision: 2,
      priceLamports: '50000000',
    },
    listingAllowed: false,
    paymentAllowed: false,
    deliveryAllowed: false,
    signingAllowed: false,
  });
  expect(calls.every((call) => call.sql.startsWith('SELECT'))).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it('requires exact origin, JSON, bounded bodies and no extra seller claims', async () => {
  expect((await post({}, {})).status).toBe(403);
  expect(
    (
      await post(
        {},
        { origin: 'http://localhost', 'content-type': 'text/plain' },
      )
    ).status,
  ).toBe(415);
  expect(
    (
      await post({
        address: fixture.a,
        walletRevision: 2,
        priceLamports: '1',
        ownerId: 'operator',
      })
    ).status,
  ).toBe(400);
  expect(
    (await post(JSON.stringify({ padding: 'ü'.repeat(1100) }))).status,
  ).toBe(413);
  expect(calls).toEqual([]);
});
it('refuses stale revisions before returning a draft', async () => {
  expect(
    (await post({ address: fixture.a, walletRevision: 1, priceLamports: '1' }))
      .status,
  ).toBe(409);
});
it('stops cancelled work and sanitizes storage errors', async () => {
  const controller = new AbortController();
  controller.abort();
  expect((await post(undefined, undefined, controller.signal)).status).toBe(
    408,
  );
  expect(calls).toEqual([]);
  batch.mockRejectedValue(Error('<html>private SQL</html>'));
  const response = await post();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toMatch(/html|private SQL/);
});
