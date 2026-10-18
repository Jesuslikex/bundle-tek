import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { exchangeOrderReviewApiFixture } from '../test/exchange-order-review-api-fixture';
import { createExchangeOrderTransport } from './exchange-order-transport';
import {
  prepareOwnedExchangeOrderReview,
  approveOwnedExchangeOrderReview,
  attemptOwnedExchangeOrder,
  observeOwnedExchangeOrder,
  readOwnedExchangeOrder,
} from './exchange-order-service';
import { readOwnedExchangeOrderHistory } from './exchange-order-history-service';
let f: Awaited<ReturnType<typeof exchangeOrderReviewApiFixture>>;
const addr = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const provider = () => ({
  id: 'providerfixture',
  currency: 'sol',
  network: 'sol',
  fromAmount: '1.15',
  toAmount: '1.1',
  payoutAddress: f.base.funder.address,
  payinAddress: addr(9),
  refundAddress: f.refund.address,
});
const status = () => ({
  ...provider(),
  fromCurrency: 'sol',
  toCurrency: 'sol',
  fromNetwork: 'sol',
  toNetwork: 'sol',
  expectedAmountFrom: '1.15',
  expectedAmountTo: '1.1',
  status: 'finished',
});
async function approved() {
  const saved = await prepareOwnedExchangeOrderReview(
    f.db,
    'alice',
    f.input,
    () => f.now,
  );
  await approveOwnedExchangeOrderReview(
    f.db,
    'alice',
    {
      reviewId: saved.terms.id,
      sha256: saved.sha256,
      exactAmountsAndNetwork: true,
      providerCustody: true,
      verificationMayBeRequired: true,
      refundAddressReviewed: true,
    },
    () => f.now,
  );
  return { reviewId: saved.terms.id, sha256: saved.sha256 };
}
const signal = () => new AbortController().signal;
beforeEach(async () => {
  f = await exchangeOrderReviewApiFixture();
});
afterEach(() => f.client.close());
it('composes exact synthetic HTTP creation and status with immutable SQL, retaining one attempt and no payout authority', async () => {
  const input = await approved(),
    fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      Response.json(init?.method === 'POST' ? provider() : status()),
    ),
    transport = createExchangeOrderTransport({
      enabled: true,
      key: 'synthetic-server-key',
      fetchImpl: fetcher,
    });
  const order = await attemptOwnedExchangeOrder(
    f.db,
    'alice',
    input,
    signal(),
    transport,
    () => f.now,
  );
  expect(order).toMatchObject({
    state: 'provider-order-matched',
    providerReferenceRetained: true,
    payoutVerified: false,
    signingAllowed: false,
    fundingAllowed: false,
    executionAllowed: false,
  });
  await attemptOwnedExchangeOrder(
    f.db,
    'alice',
    input,
    signal(),
    transport,
    () => f.now,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  await observeOwnedExchangeOrder(
    f.db,
    'alice',
    input.reviewId,
    signal(),
    transport,
    () => f.now,
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  const publicOrder = await readOwnedExchangeOrderHistory(
    f.db,
    'alice',
    input.reviewId,
  );
  expect(publicOrder).toMatchObject({
    state: 'payout-unverified',
    providerStatus: 'finished',
    payout: null,
    currentSpendabilityVerified: false,
    retryCreationAllowed: false,
    orderCreationAllowed: false,
    depositInstructionsAllowed: false,
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(JSON.stringify(publicOrder)).not.toContain('providerfixture');
  expect(JSON.stringify(publicOrder)).not.toContain('synthetic-server-key');
});
it('keeps an ambiguous HTTP response held and never automatically creates a replacement', async () => {
  const input = await approved(),
    fetcher = vi.fn<typeof fetch>(
      async () => new Response('private provider failure', { status: 503 }),
    ),
    transport = createExchangeOrderTransport({
      enabled: true,
      key: 'synthetic-server-key',
      fetchImpl: fetcher,
    });
  const order = await attemptOwnedExchangeOrder(
    f.db,
    'alice',
    input,
    signal(),
    transport,
    () => f.now,
  );
  expect(order).toMatchObject({
    state: 'creation-unresolved',
    providerReferenceRetained: false,
    retryCreationAllowed: false,
  });
  await attemptOwnedExchangeOrder(
    f.db,
    'alice',
    input,
    signal(),
    transport,
    () => f.now,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(
    observeOwnedExchangeOrder(
      f.db,
      'alice',
      input.reviewId,
      signal(),
      transport,
      () => f.now,
    ),
  ).rejects.toThrow('No provider reference');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('retains the returned reference before rejecting wrong order amounts and reconciles only through lookup', async () => {
  const input = await approved(),
    fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      Response.json(
        init?.method === 'POST'
          ? { ...provider(), fromAmount: '1.2' }
          : status(),
      ),
    ),
    transport = createExchangeOrderTransport({
      enabled: true,
      key: 'synthetic-server-key',
      fetchImpl: fetcher,
    });
  const order = await attemptOwnedExchangeOrder(
    f.db,
    'alice',
    input,
    signal(),
    transport,
    () => f.now,
  );
  expect(order).toMatchObject({
    state: 'creation-unresolved',
    providerReferenceRetained: true,
    retryCreationAllowed: false,
  });
  await observeOwnedExchangeOrder(
    f.db,
    'alice',
    input.reviewId,
    signal(),
    transport,
    () => f.now,
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    fetcher.mock.calls.filter(([, init]) => init?.method === 'POST'),
  ).toHaveLength(1);
  expect(
    await readOwnedExchangeOrder(f.db, 'alice', input.reviewId),
  ).toMatchObject({
    payoutVerified: false,
    retryCreationAllowed: false,
    fundingAllowed: false,
    signingAllowed: false,
  });
});
it('refuses a changed deposit address on lookup without storing a new observation or creating another order', async () => {
  const input = await approved(),
    fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      Response.json(
        init?.method === 'POST'
          ? provider()
          : { ...status(), payinAddress: addr(10) },
      ),
    ),
    transport = createExchangeOrderTransport({
      enabled: true,
      key: 'synthetic-server-key',
      fetchImpl: fetcher,
    });
  await attemptOwnedExchangeOrder(
    f.db,
    'alice',
    input,
    signal(),
    transport,
    () => f.now,
  );
  await expect(
    observeOwnedExchangeOrder(
      f.db,
      'alice',
      input.reviewId,
      signal(),
      transport,
      () => f.now,
    ),
  ).rejects.toThrow('deposit address changed');
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM exchange_funding_order_observations',
      )
    ).rows[0].n,
  ).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    (await readOwnedExchangeOrder(f.db, 'alice', input.reviewId))
      .retryCreationAllowed,
  ).toBe(false);
});

it('keeps a response missing the refund echo unresolved rather than inventing provider agreement', async () => {
  const input = await approved();
  const { refundAddress: unused, ...missing } = provider();
  void unused;
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(missing)),
    transport = createExchangeOrderTransport({
      enabled: true,
      key: 'synthetic-server-key',
      fetchImpl: fetcher,
    });
  const order = await attemptOwnedExchangeOrder(
    f.db,
    'alice',
    input,
    signal(),
    transport,
    () => f.now,
  );
  expect(order).toMatchObject({
    state: 'creation-unresolved',
    providerReferenceRetained: true,
    retryCreationAllowed: false,
    fundingAllowed: false,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
