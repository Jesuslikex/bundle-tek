import { MARKETPLACE_INVENTORY_CAPACITY_MESSAGE } from '@/lib/marketplace-owned-inventory';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { marketplaceOwnedFixture } from '@/test/marketplace-owned-fixture';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/marketplace-operator-policy', () => ({
  isMarketplaceOperator: (owner: string) => owner === 'founder',
}));
import { GET } from './route';
let fixture: ReturnType<typeof marketplaceOwnedFixture>;
let queries: string[];
const batch = vi.fn();
beforeEach(() => {
  fixture = marketplaceOwnedFixture();
  queries = [];
  mocks.user = { userId: 'founder' };
  batch.mockImplementation(async () =>
    [
      fixture.sources.wallets,
      fixture.sources.proofs,
      fixture.sources.runs,
      fixture.sources.receipts,
    ].map((results) => ({ success: true, results })),
  );
  mocks.db = {
    prepare(sql: string) {
      queries.push(sql);
      return {
        bind() {
          return {};
        },
      };
    },
    batch,
  } as unknown as D1Database;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No provider request allowed');
    }),
  );
});
afterEach(() => {
  batch.mockReset();
  vi.unstubAllGlobals();
});
function read(signal?: AbortSignal) {
  return GET(
    new Request('http://localhost/api/marketplace/operator/inventory', {
      signal,
    }),
  );
}
it.each([null, { userId: 'not-an-operator' }])(
  'checks founder access before any SQL for %j',
  async (user) => {
    mocks.user = user;
    const result = await read();
    expect(result.status).toBe(user ? 403 : 401);
    expect(queries).toEqual([]);
    expect(batch).not.toHaveBeenCalled();
  },
);
it('returns the real read-only builder snapshot for the authorized founder', async () => {
  const result = await read();
  expect(result.status).toBe(200);
  expect(result.headers.get('cache-control')).toBe('no-store');
  expect(await result.json()).toMatchObject({
    listingEnabled: false,
    purchaseEnabled: false,
    deliveryEnabled: false,
    wallets: expect.any(Array),
  });
  expect(queries).toHaveLength(4);
  expect(queries.every((query) => query.startsWith('SELECT '))).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['saved-history-run-limit', 'saved-history-byte-limit'])(
  'returns a fixed409 for %s without changing source limits',
  async (code) => {
    const original = fixture.sources.runs[0] as { document: string };
    fixture.sources.runs = Array.from(
      { length: code === 'saved-history-run-limit' ? 101 : 64 },
      (_, index) => ({
        ...original,
        id: `capacity-${index}`,
        document:
          code === 'saved-history-byte-limit'
            ? original.document +
              ' '.repeat(
                65536 - new TextEncoder().encode(original.document).length,
              ) +
              (index === 63 ? ' ' : '')
            : original.document,
      }),
    );
    const result = await read();
    expect(result.status).toBe(409);
    expect(result.headers.get('cache-control')).toBe('no-store');
    const body = await result.json();
    expect(body).toEqual({
      error: MARKETPLACE_INVENTORY_CAPACITY_MESSAGE,
      format: 'marketplace-inventory-capacity-v1',
      errorCode: code,
      inventoryShown: false,
      listingEnabled: false,
      purchaseEnabled: false,
      deliveryEnabled: false,
    });
    expect(body).not.toHaveProperty('wallets');
    expect(fetch).not.toHaveBeenCalled();
  },
);
it('keeps corruption and storage failures generic rather than inventing capacity', async () => {
  (fixture.sources.runs[0] as { document: string }).document =
    'private invalid history';
  const result = await read();
  expect(result.status).toBe(503);
  expect(await result.text()).not.toMatch(/private|capacity|SQLITE|JSON/);
  batch.mockRejectedValueOnce(Error('private SQL details'));
  const failed = await read();
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain('private');
});
it('gives cancellation precedence before SQL and after the snapshot arrives', async () => {
  const controller = new AbortController();
  controller.abort();
  expect((await read(controller.signal)).status).toBe(408);
  expect(queries).toEqual([]);
  const during = new AbortController();
  batch.mockImplementationOnce(async () => {
    during.abort();
    return [
      fixture.sources.wallets,
      fixture.sources.proofs,
      fixture.sources.runs,
      fixture.sources.receipts,
    ].map((results) => ({ results }));
  });
  expect((await read(during.signal)).status).toBe(408);
  expect(fetch).not.toHaveBeenCalled();
});
