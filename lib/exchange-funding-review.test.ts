import { expect, it } from 'vitest';
import { exchangeFundingReviewFixture } from '@/test/exchange-funding-review-fixture';
import {
  decodeExchangeFundingReview,
  exchangeSolDisplay,
  exchangeSolLamports,
} from './exchange-funding-review';
it('round-trips exact public review amounts and bounded SOL input', () => {
  const { review } = exchangeFundingReviewFixture();
  expect(decodeExchangeFundingReview(review)).toEqual(review);
  expect(exchangeSolLamports('12345678.000000001')).toBe('12345678000000001');
  expect(exchangeSolDisplay('12345678000000001')).toBe('12345678.000000001');
  expect(exchangeSolDisplay('0')).toBe('0');
});
it.each(['0', '-1', '1e3', '01', '1.0000000001', '18446744073.709551616'])(
  'refuses invalid payout input %s',
  (value) => {
    expect(() => exchangeSolLamports(value)).toThrow();
  },
);
it.each([
  { signingAllowed: true },
  { fundingAllowed: true },
  { orderCreationAllowed: true },
  { executionAllowed: true },
  { durableReview: false },
  { providerReference: 'secret' },
  { network: 'devnet' },
  { currency: 'USDC' },
  { depositLamports: '1000000000' },
  { providerCostLamports: '1' },
  { undistributedPayoutLamports: '0' },
  { expectedPayoutLamports: '1e9' },
  { expectedPayoutLamports: '18446744073709551616' },
  { funder: 'not an address' },
])('refuses inconsistent or privileged public evidence %j', (change) => {
  expect(() =>
    decodeExchangeFundingReview({
      ...exchangeFundingReviewFixture().review,
      ...change,
    }),
  ).toThrow();
});
it('refuses impossible timestamps and empty payouts', () => {
  const { review } = exchangeFundingReviewFixture();
  expect(() =>
    decodeExchangeFundingReview({ ...review, expiresAt: review.quotedAt }),
  ).toThrow();
  expect(() =>
    decodeExchangeFundingReview({ ...review, planUpdatedAt: 'bad' }),
  ).toThrow();
  expect(() =>
    decodeExchangeFundingReview({ ...review, expectedPayoutLamports: '0' }),
  ).toThrow();
});
