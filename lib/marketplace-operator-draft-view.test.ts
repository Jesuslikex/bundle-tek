import { expect, it } from 'vitest';
import { marketplaceOwnedFixture } from '../test/marketplace-owned-fixture';
import { buildMarketplaceOwnedInventory } from './marketplace-owned-inventory';
import { reviewOperatorListing } from './marketplace-operator-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import {
  admitOperatorDraft,
  operatorDraftRequest,
  operatorDraftCanonical as canonical,
  type OperatorDraftRecord,
} from './marketplace-operator-draft-view';
const now = Date.parse('2026-10-20T12:00:00Z');
async function fixture() {
  const inventory = buildMarketplaceOwnedInventory(
      marketplaceOwnedFixture(now).sources,
      now,
    ),
    selection = {
      address: inventory.wallets[0].address,
      walletRevision: 2,
      priceLamports: '50000000',
    };
  const review = await reviewOperatorListing(inventory, selection, now),
    request = operatorDraftRequest(crypto.randomUUID(), review, true);
  const record: OperatorDraftRecord = {
    format: 'bundle-operator-draft-v1',
    id: request.id,
    createdAt: new Date(now + 1000).toISOString(),
    sourceObservedAt: new Date(now + 500).toISOString(),
    acknowledgement: request.acknowledgement,
    review,
    reviewSha256: await digest(canonical(review)),
    publicationAllowed: false,
    paymentAllowed: false,
    deliveryAllowed: false,
    signingAllowed: false,
  };
  return { inventory, selection, review, request, record };
}
it('replays the original reviewed snapshot from a later capture without renewing history, approval or expiry', async () => {
  const f = await fixture();
  const fresh = buildMarketplaceOwnedInventory(
    marketplaceOwnedFixture(now).sources,
    now + 500,
  );
  expect(
    await reviewOperatorListing(fresh, f.selection, now + 500, now),
  ).toEqual(f.review);
  expect(await admitOperatorDraft(f.record, f.request, now + 86400000)).toEqual(
    f.record,
  );
  expect(f.record.review.evidence.latestHistory?.observedAt).toBe(
    f.inventory.wallets[0].latestHistory?.observedAt,
  );
});
it('requires a separate explicit save acknowledgement and strict selection', async () => {
  const f = await fixture();
  expect(() => operatorDraftRequest(f.request.id, f.review, false)).toThrow(
    'Acknowledge',
  );
  await expect(
    admitOperatorDraft(
      f.record,
      { ...f.request, selection: { ...f.selection, priceLamports: '1' } },
      now + 1000,
    ),
  ).rejects.toThrow();
  await expect(
    admitOperatorDraft(
      f.record,
      { ...f.request, id: crypto.randomUUID() },
      now + 1000,
    ),
  ).rejects.toThrow();
});
it.each([
  'price',
  'disclosure',
  'evidence',
  'hash',
  'gate',
  'expiry',
  'source-time',
  'created-time',
  'id',
  'extra',
] as const)('refuses saved draft mutation: %s', async (kind) => {
  const f = await fixture();
  const r = structuredClone(f.record);
  if (kind === 'price') r.review.selection.priceLamports = '1';
  if (kind === 'disclosure')
    Object.assign(r.review, { disclosure: 'Exclusive custody guaranteed' });
  if (kind === 'evidence') r.review.evidence.warmupReceiptCount++;
  if (kind === 'hash') r.reviewSha256 = '0'.repeat(64);
  if (kind === 'gate') Object.assign(r, { publicationAllowed: true });
  if (kind === 'expiry')
    r.review.reviewExpiresAt = new Date(now + 181000).toISOString();
  if (kind === 'source-time')
    r.sourceObservedAt = new Date(now - 1).toISOString();
  if (kind === 'created-time')
    r.createdAt = new Date(now + 180000).toISOString();
  if (kind === 'id') r.id = crypto.randomUUID();
  if (kind === 'extra') Object.assign(r, { privateKey: 'forbidden' });
  await expect(
    admitOperatorDraft(r, f.request, now + 86400000),
  ).rejects.toThrow();
});
it('refuses expired or future historical review replay even with a fresh inventory', async () => {
  const f = await fixture();
  await expect(
    reviewOperatorListing(f.inventory, f.selection, now, now + 1),
  ).rejects.toThrow();
  await expect(
    reviewOperatorListing(f.inventory, f.selection, now + 180000, now),
  ).rejects.toThrow();
});
