import { afterEach, expect, it } from 'vitest';
import { pairOrderFixture } from '../test/pair-order-fixture';
import { prepareOwnedImportedPairOrder } from './imported-pair-order-candidate';
import {
  buildPairOrderFirstReview,
  pairIndependentDifference,
  requirePairOrderFirstConsent,
} from './pair-order-first-review';
let f: Awaited<ReturnType<typeof pairOrderFixture>> | undefined;
afterEach(() => {
  f?.close();
  f = undefined;
});
async function setup() {
  const v = (f = await pairOrderFixture());
  v.orderState.responsePatch.priceImpactPct = '0.12';
  const candidate = await prepareOwnedImportedPairOrder(
    v.db,
    'alice',
    v.orderRequest,
    new AbortController().signal,
    v.orderDependencies,
  );
  return { v, candidate, initial: structuredClone(candidate.preflight.quote) };
}
it.each([
  ['980000', false],
  ['979999', true],
  ['1020000', false],
  ['1020001', false],
])('uses exact two-percent comparison at %s', (minimum, required) => {
  expect(
    pairIndependentDifference(minimum, '1000000').acknowledgementRequired,
  ).toBe(required);
});
it('uses BigInt beyond safe Number precision', () => {
  expect(
    pairIndependentDifference('17654110521612341000', '18014498521645246000')
      .acknowledgementRequired,
  ).toBe(true);
});
it('binds decoded minimum, venues, impact, all fees and packet to separate consent', async () => {
  const { v, candidate, initial } = await setup();
  const review = await buildPairOrderFirstReview(
    candidate,
    initial,
    '994999',
    v.clock.now,
  );
  expect(review).toMatchObject({
    minimumOutputRaw: '995000',
    priceImpactPct: '0.12',
    signingAllowed: false,
    executionAllowed: false,
    packetSha256: candidate.order.preparation.sha256,
  });
  expect(review.route.length).toBeGreaterThan(0);
  const consent = {
    reviewSha256: review.sha256,
    packetSha256: review.packetSha256,
    approvedMinimumOutputRaw: review.minimumOutputRaw,
    approveExactOrder: true as const,
    acknowledgeIndependentDifference: false,
  };
  await expect(
    requirePairOrderFirstConsent(review, consent, v.clock.now),
  ).resolves.toBeUndefined();
  for (const changed of [
    { ...consent, approvedMinimumOutputRaw: '994999' },
    { ...consent, packetSha256: '0'.repeat(64) },
    { ...consent, approveExactOrder: false },
  ]) {
    await expect(
      requirePairOrderFirstConsent(
        review,
        changed as typeof consent,
        v.clock.now,
      ),
    ).rejects.toThrow();
  }
  await expect(
    requirePairOrderFirstConsent(
      { ...review, rentRaw: '1' },
      consent,
      v.clock.now,
    ),
  ).rejects.toThrow();
  await expect(
    requirePairOrderFirstConsent(review, consent, Date.parse(review.expiresAt)),
  ).rejects.toThrow(/new review/);
});
it('requires an additional acknowledgement when initial preview differs by more than 2%', async () => {
  const { v, candidate, initial } = await setup();
  initial.quote.outAmount = '1100000';
  const review = await buildPairOrderFirstReview(
    candidate,
    initial,
    null,
    v.clock.now,
  );
  const consent = {
    reviewSha256: review.sha256,
    packetSha256: review.packetSha256,
    approvedMinimumOutputRaw: review.minimumOutputRaw,
    approveExactOrder: true as const,
    acknowledgeIndependentDifference: false,
  };
  await expect(
    requirePairOrderFirstConsent(review, consent, v.clock.now),
  ).rejects.toThrow();
  await expect(
    requirePairOrderFirstConsent(
      review,
      { ...consent, acknowledgeIndependentDifference: true },
      v.clock.now,
    ),
  ).resolves.toBeUndefined();
});
it.each([
  'absolute',
  'fresh-minimum',
  'decode',
  'input',
  'asset',
  'slots',
  'expiry',
  'reference-order',
] as const)('rejects changed %s bounds', async (mode) => {
  const { v, candidate: c, initial } = await setup();
  if (mode === 'fresh-minimum')
    c.preflight.quote.quote.minimumOutAmount = '995001';
  if (mode === 'decode') c.review.assessment.minimumOutputRaw = '994999';
  if (mode === 'input')
    initial.inputRaw = (BigInt(initial.inputRaw) + 1n).toString();
  if (mode === 'asset') initial.pair.base.decimals++;
  if (mode === 'slots') c.review.maximumSlot = c.review.minimumSlot + 33;
  if (mode === 'expiry')
    initial.quote.expiresAt = new Date(v.clock.now).toISOString();
  if (mode === 'reference-order')
    c.preflight.quote.quote.observedAt = new Date(
      Date.parse(c.order.observedAt) - 1,
    ).toISOString();
  await expect(
    buildPairOrderFirstReview(
      c,
      initial,
      mode === 'absolute' ? '995001' : null,
      v.clock.now,
    ),
  ).rejects.toThrow();
});
it.each(['NaN', Infinity, '100.01', {}, '-101'])(
  'rejects malformed order price impact %s',
  async (impact) => {
    const v = (f = await pairOrderFixture());
    v.orderState.responsePatch.priceImpactPct = impact;
    await expect(
      prepareOwnedImportedPairOrder(
        v.db,
        'alice',
        v.orderRequest,
        new AbortController().signal,
        v.orderDependencies,
      ),
    ).rejects.toThrow();
  },
);
it.each([
  '-0.0004986315722698763',
  '0.123456789012345678901234567890',
  '-100.0000',
])(
  'retains the bounded provider precision in price impact %s without amount conversion',
  async (impact) => {
    const v = (f = await pairOrderFixture());
    v.orderState.responsePatch.priceImpactPct = impact;
    const c = await prepareOwnedImportedPairOrder(
      v.db,
      'alice',
      v.orderRequest,
      new AbortController().signal,
      v.orderDependencies,
    );
    expect(c.order.priceImpactPct).toBe(impact);
  },
);
it('rejects impact beyond 100 even when floating point would round it down', async () => {
  const v = (f = await pairOrderFixture());
  v.orderState.responsePatch.priceImpactPct =
    '100.0000000000000000000000000001';
  await expect(
    prepareOwnedImportedPairOrder(
      v.db,
      'alice',
      v.orderRequest,
      new AbortController().signal,
      v.orderDependencies,
    ),
  ).rejects.toThrow();
});
