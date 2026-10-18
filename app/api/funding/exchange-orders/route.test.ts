import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  list: vi.fn(),
  read: vi.fn(),
  db: {},
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => state.user,
}));
vi.mock('@/db', () => ({ getD1: () => state.db }));
vi.mock('@/lib/exchange-order-history-service', () => ({
  listOwnedExchangeOrderHistory: state.list,
  readOwnedExchangeOrderHistory: state.read,
}));
import { GET } from './route';
import { ExchangeFundingError } from '@/lib/exchange-funding-quote';
import { ExchangePayoutError } from '@/lib/exchange-payout-receipt';
const get = (query: string) =>
  GET(new Request('https://bundle.test/api/funding/exchange-orders?' + query));
beforeEach(() => {
  state.user = { userId: 'alice' };
  state.list.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  state.read.mockReset().mockResolvedValue({ id: 'fixture' });
});
it('requires authentication before stored order reads', async () => {
  state.user = null;
  expect((await get('planId=draft')).status).toBe(401);
  expect(state.list).not.toHaveBeenCalled();
  expect(state.read).not.toHaveBeenCalled();
});
it('passes only the trusted owner and one order or plan/cursor selection, with no caching', async () => {
  const response = await get('planId=saved&before=cursor');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(state.list).toHaveBeenCalledWith(state.db, 'alice', 'saved', 'cursor');
  expect(await (await get('id=order')).json()).toEqual({
    order: { id: 'fixture' },
  });
  expect(state.read).toHaveBeenCalledWith(state.db, 'alice', 'order');
});
it.each([
  '',
  'planId=x&planId=y',
  'id=x&id=y',
  'id=x&planId=y',
  'planId=x&unknown=y',
  'before=x',
  'planId=x&before=y&owner=bob',
  'id=x&action=submit',
])('refuses ambiguous or unsupported selection %s', async (query) => {
  expect((await get(query)).status).toBe(400);
  expect(state.list).not.toHaveBeenCalled();
  expect(state.read).not.toHaveBeenCalled();
});
it.each([
  new ExchangeFundingError('Not found', 404),
  new ExchangePayoutError('Saved payout receipt is inconsistent.', 503),
])('preserves safe domain refusals', async (error) => {
  state.read.mockRejectedValue(error);
  const r = await get('id=order');
  expect(r.status).toBe(error.status);
  expect(await r.json()).toEqual({ error: error.message });
});
it('sanitizes unexpected storage failures', async () => {
  state.list.mockRejectedValue(new Error('private-provider-url'));
  const r = await get('planId=saved');
  expect(r.status).toBe(503);
  expect(JSON.stringify(await r.json())).not.toContain('private-provider');
});
