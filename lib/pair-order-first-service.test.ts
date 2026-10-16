import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { pairOrderFixture } from '../test/pair-order-fixture';
import {
  quoteOwnedImportedPair,
  createPairOrderQuoteScope,
} from './imported-pair-quote-service';
import {
  approveOwnedPairOrderFirstReview,
  prepareOwnedPairOrderFirstReview,
  readOwnedPairOrderFirstReview,
  pairOrderFirstRequest,
} from './pair-order-first-service';
let f: Awaited<ReturnType<typeof pairOrderFixture>> | undefined;
afterEach(() => {
  f?.close();
  f = undefined;
});
it.each(['third', 'changed-request', 'expired', 'forged'] as const)(
  'fails closed on %s quote continuations without removing the public rate gate',
  async (mode) => {
    const { v } = await setup();
    const provider = {
      ...v.orderDependencies,
      quoteScope: mode === 'forged' ? {} : createPairOrderQuoteScope(),
    };
    const input = v.request;
    if (mode === 'forged') {
      await expect(
        quoteOwnedImportedPair(
          v.db,
          'alice',
          input,
          new AbortController().signal,
          provider,
        ),
      ).rejects.toThrow(/continuation/);
      return;
    }
    await quoteOwnedImportedPair(
      v.db,
      'alice',
      input,
      new AbortController().signal,
      provider,
    );
    await expect(
      quoteOwnedImportedPair(
        v.db,
        'alice',
        input,
        new AbortController().signal,
        v.orderDependencies,
      ),
    ).rejects.toMatchObject({ status: 429 });
    if (mode === 'expired') v.clock.now += 25000;
    if (mode === 'third')
      await quoteOwnedImportedPair(
        v.db,
        'alice',
        input,
        new AbortController().signal,
        provider,
      );
    await expect(
      quoteOwnedImportedPair(
        v.db,
        'alice',
        mode === 'changed-request' ? { ...input, amount: '0.00000002' } : input,
        new AbortController().signal,
        provider,
      ),
    ).rejects.toThrow(/continuation/);
  },
);
async function setup() {
  const v = (f = await pairOrderFixture());
  v.sqlite.exec(
    readFileSync(
      new URL('../drizzle/0089_pair_order_first_reviews.sql', import.meta.url),
      'utf8',
    ).replaceAll('--> statement-breakpoint', ''),
  );
  const request = { ...v.orderRequest, absoluteMinimumRaw: null };
  const run = () =>
    prepareOwnedPairOrderFirstReview(
      v.db,
      'alice',
      request,
      new AbortController().signal,
      v.orderDependencies,
    );
  return { v, request, run };
}
it('captures a server baseline, prepares once, then quotes again before review and stores immutable owned evidence', async () => {
  const { v, run } = await setup();
  const stages: string[] = [];
  const quote = v.quote.getMockImplementation()!,
    prepare = v.prepare.getMockImplementation()!;
  v.quote.mockImplementation(async (...args) => {
    stages.push('quote');
    return quote(...args);
  });
  v.prepare.mockImplementation(async (...args) => {
    stages.push('order');
    return prepare(...args);
  });
  const saved = await run();
  expect(stages).toEqual(['quote', 'order', 'quote']);
  expect(saved.review.minimumOutputRaw).toBe('995000');
  expect(
    (await readOwnedPairOrderFirstReview(v.db, 'alice', saved.id)).review,
  ).toEqual(saved.review);
  await expect(
    readOwnedPairOrderFirstReview(v.db, 'bob', saved.id),
  ).rejects.toMatchObject({ status: 404 });
  expect(() =>
    v.sqlite.exec('UPDATE pair_order_first_reviews SET sha256=sha256'),
  ).toThrow(/Immutable/);
  expect(() => v.sqlite.exec('DELETE FROM pair_order_first_reviews')).toThrow(
    /Immutable/,
  );
  const consent = {
    reviewSha256: saved.review.sha256,
    packetSha256: saved.review.packetSha256,
    approvedMinimumOutputRaw: '995000',
    approveExactOrder: true as const,
    acknowledgeIndependentDifference: false,
  };
  await expect(
    approveOwnedPairOrderFirstReview(
      v.db,
      'alice',
      saved.id,
      consent,
      v.clock.now,
    ),
  ).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining('disabled'),
  });
  await expect(
    approveOwnedPairOrderFirstReview(
      v.db,
      'alice',
      saved.id,
      consent,
      Date.parse(saved.review.expiresAt),
    ),
  ).rejects.toThrow(/new review/);
});
it('accepts an independent preview difference only as a new review, without weakening the fresh minimum', async () => {
  const { v, run } = await setup();
  const quote = v.quote.getMockImplementation()!;
  let count = 0;
  v.quote.mockImplementation(async (...args) => {
    const q = await quote(...args);
    return ++count === 1
      ? { ...q, outAmount: '1100000', minimumOutAmount: '1094500' }
      : q;
  });
  const saved = await run();
  expect(saved.review.independent.acknowledgementRequired).toBe(true);
  expect(saved.review.minimumOutputRaw).toBe('995000');
});
it('rejects one unit below the fresh reference, with no saved review', async () => {
  const { v, run } = await setup();
  const quote = v.quote.getMockImplementation()!;
  let count = 0;
  v.quote.mockImplementation(async (...args) => {
    const q = await quote(...args);
    return ++count === 2 ? { ...q, minimumOutAmount: '995001' } : q;
  });
  await expect(run()).rejects.toMatchObject({ status: 409 });
  expect(
    v.sqlite
      .prepare('SELECT count(*) AS n FROM pair_order_first_reviews')
      .get()!.n,
  ).toBe(0);
});
it('rejects changed ownership at the storage boundary', async () => {
  const { v, run } = await setup();
  v.orderState.onSimulation = () => {
    v.sqlite.exec('UPDATE workspace_wallets SET archived=1');
  };
  await expect(run()).rejects.toThrow();
  expect(
    v.sqlite
      .prepare('SELECT count(*) AS n FROM pair_order_first_reviews')
      .get()!.n,
  ).toBe(0);
});
it.each([
  {},
  { absoluteMinimumRaw: '0' },
  { absoluteMinimumRaw: '18446744073709551616' },
  { absoluteMinimumRaw: 1 },
  { absoluteMinimumRaw: null, enableSigning: true },
])('rejects malformed or extra request fields', async (extra) => {
  const { v } = await setup();
  expect(() =>
    pairOrderFirstRequest({ ...v.orderRequest, ...extra }),
  ).toThrow();
});
