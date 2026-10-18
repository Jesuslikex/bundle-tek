import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { exchangeOrderReviewApiFixture } from '@/test/exchange-order-review-api-fixture';
import { decodeExchangeOrderHistoryDetail } from '@/lib/exchange-order-history';
const state = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as D1Database | null,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => state.user,
}));
vi.mock('@/db', () => ({
  getD1: () => {
    if (!state.db) throw Error('DB unavailable');
    return state.db;
  },
}));
import { GET, POST } from './route';
let f: Awaited<ReturnType<typeof exchangeOrderReviewApiFixture>>;
const fetcher = vi.fn(() => {
  throw Error('No provider calls allowed');
});
const request = (
  input: unknown = f.input,
  headers: Record<string, string> = {
    origin: 'https://bundle.test',
    'content-type': 'application/json',
  },
) =>
  new Request('https://bundle.test/api/funding/exchange-order-review', {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
const read = () =>
  GET(
    new Request(
      'https://bundle.test/api/funding/exchange-order-review?quoteId=' +
        f.base.review.id,
    ),
  );
async function count(table: string) {
  return (await f.client.execute('SELECT count(*) AS n FROM ' + table)).rows[0]
    .n;
}
beforeEach(async () => {
  f = await exchangeOrderReviewApiFixture();
  state.db = f.db;
  state.user = { userId: 'alice' };
  vi.spyOn(Date, 'now').mockReturnValue(f.now);
  vi.stubGlobal('fetch', fetcher.mockClear());
});
afterEach(() => {
  f.client.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('saves one immutable owned review, recovers it after expiry, and creates no approval, attempt or provider activity', async () => {
  expect(await (await read()).json()).toEqual({ order: null });
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = (await response.json()) as { order: unknown },
    order = decodeExchangeOrderHistoryDetail(body.order);
  expect(order).toMatchObject({
    refundAddress: f.refund.address,
    state: 'review',
    approved: false,
    providerReferenceRetained: false,
    orderCreationAllowed: false,
    depositInstructionsAllowed: false,
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(JSON.stringify(body)).not.toContain('private-fixture');
  expect(await (await POST(request())).json()).toEqual(body);
  expect(await count('exchange_funding_order_reviews')).toBe(1);
  for (const table of [
    'exchange_funding_order_approvals',
    'exchange_funding_order_attempts',
    'exchange_funding_order_observations',
    'exchange_funding_payout_receipts',
  ])
    expect(await count(table)).toBe(0);
  vi.mocked(Date.now).mockReturnValue(f.now + 61000);
  expect(await (await read()).json()).toEqual(body);
  expect(fetcher).not.toHaveBeenCalled();
});
it('refuses auth, cross-origin, MIME, oversize and injected authority without saving', async () => {
  state.user = null;
  expect((await POST(request())).status).toBe(401);
  expect((await read()).status).toBe(401);
  state.user = { userId: 'alice' };
  expect(
    (await POST(request(f.input, { 'content-type': 'application/json' })))
      .status,
  ).toBe(403);
  expect(
    (
      await POST(
        request(f.input, {
          origin: 'https://other.test',
          'content-type': 'application/json',
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await POST(
        request(f.input, {
          origin: 'https://bundle.test',
          'content-type': 'text/plain',
        }),
      )
    ).status,
  ).toBe(415);
  expect((await POST(request('x'.repeat(2049)))).status).toBe(413);
  for (const input of [
    { ...f.input, orderCreationAllowed: true },
    { ...f.input, providerUrl: 'https://bad.test' },
    { ...f.input, consent: true },
    { ...f.input, refund: { ...f.refund, revision: 0 } },
  ])
    expect((await POST(request(input))).status).toBe(400);
  expect(await count('exchange_funding_order_reviews')).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
});
it('requires both current proven wallets and the exact live draft revisions', async () => {
  await f.client.execute({
    sql: 'DELETE FROM wallet_ownership_proofs WHERE address=?',
    args: [f.refund.address],
  });
  expect((await POST(request())).status).toBe(409);
  await f.client.execute({
    sql: 'INSERT INTO wallet_ownership_proofs VALUES(?,?,?)',
    args: ['alice', 'Solana', f.refund.address],
  });
  expect(
    (await POST(request({ ...f.input, refund: { ...f.refund, revision: 3 } })))
      .status,
  ).toBe(409);
  await f.client.execute('UPDATE funding_plans SET revision=revision+1');
  expect((await POST(request())).status).toBe(409);
  expect(await count('exchange_funding_order_reviews')).toBe(0);
});
it('does not expose another owner review and rejects a changed refund or expired quote', async () => {
  expect((await POST(request())).status).toBe(200);
  state.user = { userId: 'bob' };
  expect(await (await read()).json()).toEqual({ order: null });
  expect((await POST(request())).status).toBe(404);
  state.user = { userId: 'alice' };
  expect(
    (
      await POST(
        request({
          ...f.input,
          refund: {
            address: f.base.funder.address,
            revision: f.base.funder.revision,
          },
        }),
      )
    ).status,
  ).toBe(400);
  vi.mocked(Date.now).mockReturnValue(f.now + 60000);
  expect((await POST(request())).status).toBe(409);
  expect(await count('exchange_funding_order_reviews')).toBe(1);
});
it('rejects malformed or duplicated recovery selectors and hides storage diagnostics', async () => {
  for (const query of [
    '',
    '?quoteId=nope',
    '?quoteId=' + f.base.review.id + '&quoteId=' + f.base.review.id,
    '?quoteId=' + f.base.review.id + '&id=foreign',
  ])
    expect(
      (
        await GET(
          new Request(
            'https://bundle.test/api/funding/exchange-order-review' + query,
          ),
        )
      ).status,
    ).toBe(400);
  state.db = null;
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain('DB unavailable');
});
it('bounds an unfinished body without a write or automatic retry', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{'));
    },
    cancel() {
      return new Promise<void>(() => {});
    },
  });
  const response = POST(
    new Request('https://bundle.test/api/funding/exchange-order-review', {
      method: 'POST',
      headers: {
        origin: 'https://bundle.test',
        'content-type': 'application/json',
      },
      body: stream,
      duplex: 'half',
    } as RequestInit),
  );
  await vi.advanceTimersByTimeAsync(5000);
  expect((await response).status).toBe(503);
  expect(await count('exchange_funding_order_reviews')).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
});
