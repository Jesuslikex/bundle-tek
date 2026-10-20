import { expect, it } from 'vitest';
import { marketplaceOwnedFixture } from '../test/marketplace-owned-fixture';
import { buildMarketplaceOwnedInventory } from './marketplace-owned-inventory';
import {
  reviewOperatorListing,
  admitOperatorListingReview,
  MARKETPLACE_OPERATOR_DISCLOSURE,
} from './marketplace-operator-review';
const now = Date.parse('2026-10-20T12:00:00Z');
function fixture() {
  const raw = marketplaceOwnedFixture(now);
  return {
    ...raw,
    inventory: buildMarketplaceOwnedInventory(raw.sources, now),
    selection: { address: raw.a, walletRevision: 2, priceLamports: '50000000' },
  };
}
it('binds the exact owned wallet, revision, price and custody disclosure with all publication/execution gates false', async () => {
  const f = fixture(),
    review = await reviewOperatorListing(f.inventory, f.selection, now);
  expect(review).toMatchObject({
    sellerModel: 'bundle-operated',
    selection: f.selection,
    disclosure: MARKETPLACE_OPERATOR_DISCLOSURE,
    listingAllowed: false,
    paymentAllowed: false,
    deliveryAllowed: false,
    signingAllowed: false,
  });
  expect(
    await admitOperatorListingReview(review, f.inventory, f.selection, now),
  ).toEqual(review);
  expect(review.requestSha256).toHaveLength(64);
  expect(review.evidenceSha256).toHaveLength(64);
});
it('advances only derived evidence age without refreshing the historical balance or control proof', async () => {
  const f = fixture(),
    review = await reviewOperatorListing(f.inventory, f.selection, now + 10000);
  expect(review.evidence.observedActivityAgeSeconds).toBe(30 * 86400 + 10);
  expect(review.evidence.latestHistory?.observedAt).toBe(
    f.observation.observedAt,
  );
  expect(
    await admitOperatorListingReview(
      review,
      f.inventory,
      f.selection,
      now + 11000,
    ),
  ).toEqual(review);
});
it.each([
  'price',
  'wallet',
  'revision',
  'disclosure',
  'evidence',
  'hash',
  'gate',
  'expiry',
] as const)('refuses a changed operator review: %s', async (kind) => {
  const f = fixture(),
    review = await reviewOperatorListing(f.inventory, f.selection, now);
  if (kind === 'price') review.selection.priceLamports = '1';
  if (kind === 'wallet') review.selection.address = f.b;
  if (kind === 'revision') review.selection.walletRevision = 3;
  if (kind === 'disclosure')
    Object.assign(review, { disclosure: 'Exclusive keys guaranteed' });
  if (kind === 'evidence') review.evidence.warmupReceiptCount++;
  if (kind === 'hash') review.requestSha256 = '0'.repeat(64);
  if (kind === 'gate') Object.assign(review, { listingAllowed: true });
  if (kind === 'expiry')
    review.reviewExpiresAt = new Date(now + 61000).toISOString();
  await expect(
    admitOperatorListingReview(review, f.inventory, f.selection, now),
  ).rejects.toThrow();
});
it('refuses unknown/stale wallets, unsupported prices, extra client claims and expired reviews', async () => {
  const f = fixture();
  for (const input of [
    { ...f.selection, address: '1'.repeat(32) },
    { ...f.selection, walletRevision: 1 },
    { ...f.selection, priceLamports: '0' },
    { ...f.selection, priceLamports: '0.1' },
    { ...f.selection, priceLamports: '18446744073709551616' },
    { ...f.selection, operator: true },
  ])
    await expect(
      reviewOperatorListing(f.inventory, input, now),
    ).rejects.toThrow();
  const review = await reviewOperatorListing(f.inventory, f.selection, now);
  await expect(
    admitOperatorListingReview(review, f.inventory, f.selection, now + 60000),
  ).rejects.toThrow();
});
