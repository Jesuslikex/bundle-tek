import { expect, it } from 'vitest';
import {
  savedAutoSellReview,
  validatedAutoSellReviewReference,
  AutoSellReviewRecoveryError,
} from './auto-sell-review-recovery';
import {
  autoSellReviewReference as ref,
  autoSellUnsignedReviewPage,
} from '../test/auto-sell-review-fixture';
it('admits only detached lookup metadata with no signature/packet/authority', () => {
  const mutable = { ...ref };
  const saved = validatedAutoSellReviewReference(mutable);
  mutable.inputRaw = '1';
  expect(saved).toEqual(ref);
  expect(Object.isFrozen(saved)).toBe(true);
  expect(() =>
    validatedAutoSellReviewReference({ ...ref, transaction: 'untrusted' }),
  ).toThrow();
  const error = new AutoSellReviewRecoveryError(ref);
  expect(error.reference).toEqual(ref);
  expect('uncertain' in error).toBe(false);
});
it.each([
  { inputRaw: '0' },
  { inputRaw: '18446744073709551616' },
  { projectRevision: 0 },
  { walletRevision: 1.5 },
  { preparationSha256: 'a' },
  { preparationId: 'not-id' },
])('refuses invalid source metadata %j', (patch) => {
  expect(() =>
    validatedAutoSellReviewReference({ ...ref, ...patch }),
  ).toThrow();
});
it('projects the exact original owned review without granting signing or finality', () => {
  const result = savedAutoSellReview(autoSellUnsignedReviewPage(), ref);
  expect(result).toMatchObject({
    state: 'awaiting_signature',
    signature: null,
    finalityVerified: false,
    signingAllowed: false,
    submissionAllowed: false,
  });
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC-UNSIGNED');
});
it('does not fabricate absence or accept a partial/multiple-match page', () => {
  const page = autoSellUnsignedReviewPage();
  page.intents = [];
  expect(savedAutoSellReview(page, ref)).toBeNull();
  const duplicate = autoSellUnsignedReviewPage();
  duplicate.intents.push({ ...duplicate.intents[0] });
  expect(() => savedAutoSellReview(duplicate, ref)).toThrow();
  const cursor = autoSellUnsignedReviewPage();
  cursor.nextCursor = cursor.intents[0].id;
  expect(() => savedAutoSellReview(cursor, ref)).toThrow();
});
it.each([
  'projectId',
  'projectRevision',
  'walletRevision',
  'preparationId',
  'wallet',
  'mint',
  'inputRaw',
  'preparationSha256',
] as const)('refuses changed source field %s', (field) => {
  const changed = { ...ref };
  if (field === 'projectRevision' || field === 'walletRevision')
    changed[field]++;
  else
    changed[field] = field.includes('Sha')
      ? 'b'.repeat(64)
      : field === 'inputRaw'
        ? '1'
        : field === 'wallet' || field === 'mint'
          ? 'So11111111111111111111111111111111111111112'
          : '44444444-4444-4444-8444-444444444444';
  expect(() =>
    savedAutoSellReview(autoSellUnsignedReviewPage(), changed),
  ).toThrow();
});
