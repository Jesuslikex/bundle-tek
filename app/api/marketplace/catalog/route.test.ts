import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  user: null as null | { userId: string },
  read: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => {
    if (mocks.user?.userId === 'auth-failure')
      throw new Error('private auth error');
    return mocks.user;
  },
}));
vi.mock('@/lib/marketplace-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/marketplace-provider')>()),
  readMarketplaceCatalog: mocks.read,
}));
import { GET } from './route';
import { MarketplaceError } from '@/lib/marketplace-provider';
const get = (query = '') =>
  GET(
    new Request(`https://bundle.example.com/api/marketplace/catalog${query}`),
  );
beforeEach(() => {
  mocks.user = { userId: 'owner' };
  mocks.read.mockReset();
});
it('requires authentication before reading any provider or parsing user filters', async () => {
  mocks.user = null;
  expect((await get('?endpoint=secret')).status).toBe(401);
  expect(mocks.read).not.toHaveBeenCalled();
});
it('reports unavailable authentication distinctly without leaking its exception', async () => {
  mocks.user = { userId: 'auth-failure' };
  const response = await get();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: 'Bundle sign-in is temporarily unavailable.',
    code: 'AUTH_UNAVAILABLE',
  });
  expect(mocks.read).not.toHaveBeenCalled();
});
it('rejects unknown, repeated and oversized filters without contacting a provider', async () => {
  for (const query of [
    '?count=25&count=50',
    '?endpoint=https://evil.example.com',
    '?count=500',
    '?source=' + 'x'.repeat(2100),
  ])
    expect((await get(query)).status).toBe(400);
  expect(mocks.read).not.toHaveBeenCalled();
});
it('returns authenticated catalog data with no-store and default filters', async () => {
  mocks.read.mockResolvedValue({ purchaseEnabled: false, listings: [] });
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(mocks.read.mock.calls[0][0]).toMatchObject({
    count: 25,
    minimumAgeDays: 1,
    minimumGapMinutes: 30,
  });
});
it('keeps unavailable/error responses honest and masks unexpected errors', async () => {
  mocks.read.mockRejectedValue(
    new MarketplaceError('No provider connected.', 503),
  );
  expect((await get()).status).toBe(503);
  mocks.read.mockRejectedValue(
    new MarketplaceError('Provider rate limited.', 429),
  );
  const limited = await get();
  expect(limited.status).toBe(429);
  expect(limited.headers.get('retry-after')).toBe('15');
  mocks.read.mockRejectedValue(new Error('secret endpoint'));
  expect(await (await get()).text()).not.toContain('secret');
});

it('forwards exact bounded ranges and rejects inverted ranges before provider access', async () => {
  mocks.read.mockResolvedValue({ purchaseEnabled: false, listings: [] });
  const response = await get(
    '?minimumBalanceLamports=9007199254740993&maximumBalanceLamports=9007199254740994&minimumAgeDays=2&maximumAgeDays=7&minimumTransactions=3&maximumTransactions=10',
  );
  expect(response.status).toBe(200);
  expect(mocks.read.mock.calls[0][0]).toMatchObject({
    minimumBalanceLamports: '9007199254740993',
    maximumBalanceLamports: '9007199254740994',
    minimumAgeDays: 2,
    maximumAgeDays: 7,
    minimumTransactions: 3,
    maximumTransactions: 10,
  });
  mocks.read.mockClear();
  for (const query of [
    '?minimumBalanceLamports=2&maximumBalanceLamports=1',
    '?minimumAgeDays=3&maximumAgeDays=2',
    '?minimumTransactions=4&maximumTransactions=3',
    '?minimumBalanceLamports=invalid&maximumBalanceLamports=1',
  ])
    expect((await get(query)).status).toBe(400);
  expect(mocks.read).not.toHaveBeenCalled();
});
