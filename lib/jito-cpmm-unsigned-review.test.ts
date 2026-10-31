import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createJitoCpmmUnsignedReview,
  requireJitoCpmmUnsignedReview,
  saveJitoCpmmUnsignedReview,
  openJitoCpmmUnsignedReview,
  JITO_RUNTIME_SIGNING_ENABLED,
} from './jito-cpmm-unsigned-review';
import {
  unsignedReviewFacts,
  unsignedReviewContext as scope,
} from '../test/jito-cpmm-unsigned-review-fixture';
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
it('binds ordered exact packet hashes and all displayed terms without authority or packet bytes', async () => {
  const review = await createJitoCpmmUnsignedReview(unsignedReviewFacts());
  expect(await requireJitoCpmmUnsignedReview(review)).toEqual(review);
  expect(Object.values(review.authority).every((v) => v === false)).toBe(true);
  expect(JITO_RUNTIME_SIGNING_ENABLED).toBe(false);
  expect(review).not.toHaveProperty('transaction');
  const opened = await openJitoCpmmUnsignedReview(bytes(review), scope);
  expect(opened).toEqual({ review, recovered: false });
  const historical = await openJitoCpmmUnsignedReview(
    Uint8Array.from(
      readFileSync('test/fixtures/jito-cpmm-unsigned-review-20261031.json'),
    ),
    scope,
  );
  expect(historical.review.sha256).toBe(
    '0b9105d23bde520fe3d5a04394b67b14e0a1044b8767b1410b8c5ac4cb0d68ab',
  );
  expect(
    BigInt(historical.review.maximumSlot) -
      BigInt(historical.review.minimumSlot),
  ).toBe(27n);
  expect(historical.recovered).toBe(false);
  expect(
    Object.values(historical.review.authority).every(
      (value) => value === false,
    ),
  ).toBe(true);
});
it('requires new explicit consent to save and never returns consent from recovery', async () => {
  const review = await createJitoCpmmUnsignedReview(unsignedReviewFacts());
  await expect(
    saveJitoCpmmUnsignedReview(review, scope, false),
  ).rejects.toThrow();
  const saved = await saveJitoCpmmUnsignedReview(
    review,
    scope,
    true,
    '2026-10-31T13:00:00.000Z',
  );
  expect(await openJitoCpmmUnsignedReview(bytes(saved), scope)).toEqual({
    review,
    recovered: true,
  });
});
for (const field of ['ownerScope', 'projectId', 'sessionId'] as const)
  it('refuses recovery under changed ' + field, async () => {
    const review = await createJitoCpmmUnsignedReview(unsignedReviewFacts());
    const saved = await saveJitoCpmmUnsignedReview(review, scope, true);
    const changed = {
      ...scope,
      [field]:
        field === 'ownerScope'
          ? 'cd'.repeat(32)
          : '33333333-3333-4333-8333-333333333333',
    };
    await expect(
      openJitoCpmmUnsignedReview(bytes(saved), changed),
    ).rejects.toThrow();
  });
for (const field of [
  'minimumOutputRaw',
  'payer',
  'packetSha256s',
  'authority',
  'sha256',
] as const)
  it('refuses altered review ' + field, async () => {
    const review = await createJitoCpmmUnsignedReview(unsignedReviewFacts());
    const changed = {
      ...review,
      [field]:
        field === 'packetSha256s'
          ? [...review.packetSha256s].reverse()
          : field === 'authority'
            ? { ...review.authority, signingAllowed: true }
            : field === 'payer'
              ? review.pool
              : field === 'sha256'
                ? '00'.repeat(32)
                : '1',
    };
    await expect(requireJitoCpmmUnsignedReview(changed)).rejects.toThrow();
  });
for (const change of [
  { maximumSlot: '133' },
  { simulationSlot: '99' },
  { minimumOutputRaw: '190001' },
  { maximumFeeLamports: '80001' },
  { networkFeeLamports: '80001' },
  { priceDifferenceBps: '-201' },
  { tipLamports: '999' },
  { inputRaw: '01' },
  { inputRaw: '18446744073709551616' },
])
  it(
    'refuses out-of-policy display facts ' + JSON.stringify(change),
    async () => {
      await expect(
        createJitoCpmmUnsignedReview({ ...unsignedReviewFacts(), ...change }),
      ).rejects.toThrow();
    },
  );
it('rejects unknown fields, duplicate JSON keys, UTF8 errors, oversized and shared bytes', async () => {
  const review = await createJitoCpmmUnsignedReview(unsignedReviewFacts());
  await expect(
    requireJitoCpmmUnsignedReview({ ...review, transaction: 'not-allowed' }),
  ).rejects.toThrow();
  const duplicate = '{"format":"other",' + JSON.stringify(review).slice(1);
  await expect(
    openJitoCpmmUnsignedReview(new TextEncoder().encode(duplicate), scope),
  ).rejects.toThrow();
  for (const raw of [
    new Uint8Array([255]),
    new Uint8Array(16385),
    new Uint8Array(new SharedArrayBuffer(8)),
  ])
    await expect(openJitoCpmmUnsignedReview(raw, scope)).rejects.toThrow();
});
it('copies facts before asynchronous hashing and refuses getters without invoking them', async () => {
  const facts = unsignedReviewFacts();
  const pending = createJitoCpmmUnsignedReview(facts);
  facts.inputRaw = '1';
  expect((await pending).inputRaw).toBe('1000000');
  let read = false;
  Object.defineProperty(facts, 'payer', {
    enumerable: true,
    get() {
      read = true;
      return '';
    },
  });
  await expect(createJitoCpmmUnsignedReview(facts)).rejects.toThrow();
  expect(read).toBe(false);
});
it('refuses altered saved time, acknowledgement, unknown fields and changed nested data', async () => {
  const review = await createJitoCpmmUnsignedReview(unsignedReviewFacts());
  const saved = await saveJitoCpmmUnsignedReview(review, scope, true);
  for (const changed of [
    { ...saved, reviewedAt: '2026-10-31T00:00:00.000Z' },
    { ...saved, acknowledgement: 'sign' },
    { ...saved, approval: true },
    { ...saved, review: { ...review, inputRaw: '2' } },
  ])
    await expect(
      openJitoCpmmUnsignedReview(bytes(changed), scope),
    ).rejects.toThrow();
});
