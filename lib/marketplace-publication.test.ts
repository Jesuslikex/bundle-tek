import { expect, it } from 'vitest';
import { marketplacePublicationFixture } from '../test/marketplace-publication-fixture';
import {
  reviewPublication,
  admitPublicationPreview,
  admitPublicationRecord,
  admitBundleCatalog,
} from './marketplace-publication';
const now = Date.parse('2026-10-20T12:00:00Z');
it('publishes only a curated Bundle-owned historical subset and preserves its dates and false financial flags', async () => {
  const f = await marketplacePublicationFixture(now);
  expect(await admitPublicationPreview(f.preview, f.draft, now)).toEqual(
    f.preview,
  );
  expect(
    await admitPublicationRecord(f.record, f.draft, f.request, now + 86400000),
  ).toEqual(f.record);
  expect(admitBundleCatalog(f.catalog, now)).toEqual(f.catalog);
  const text = JSON.stringify(f.catalog);
  for (const key of [
    'draftId',
    'owner_id',
    'label',
    'ownershipProofAt',
    'fundedAt',
    'privateKey',
  ])
    expect(text).not.toContain(key);
  expect(f.preview.listing.historicalBalance?.observedAt).toBe(
    f.draft.review.evidence.latestHistory?.observedAt,
  );
});
it.each([
  'price',
  'address',
  'disclosure',
  'hash',
  'expiry',
  'authority',
] as const)('refuses preview mutation: %s', async (kind) => {
  const f = await marketplacePublicationFixture(now),
    p = structuredClone(f.preview);
  if (kind === 'price') p.listing.priceLamports = '1';
  if (kind === 'address') p.listing.address = f.source.b;
  if (kind === 'disclosure')
    Object.assign(p.listing, { disclosure: 'Keys guaranteed exclusive' });
  if (kind === 'hash') p.contextSha256 = '0'.repeat(64);
  if (kind === 'expiry') p.expiresAt = new Date(now + 61000).toISOString();
  if (kind === 'authority') Object.assign(p, { purchaseEnabled: true });
  await expect(admitPublicationPreview(p, f.draft, now)).rejects.toThrow();
});
it('refuses stale publication approval while historical publication and withdrawal records remain readable', async () => {
  const f = await marketplacePublicationFixture(now);
  await expect(
    admitPublicationPreview(f.preview, f.draft, now + 60000),
  ).rejects.toThrow();
  await expect(
    admitPublicationRecord(
      { ...f.record, publishedAt: new Date(now + 60000).toISOString() },
      f.draft,
      undefined,
      now + 86400000,
    ),
  ).rejects.toThrow();
  expect(
    (
      await admitPublicationRecord(
        { ...f.record, withdrawnAt: new Date(now + 120000).toISOString() },
        f.draft,
        undefined,
        now + 86400000,
      )
    ).withdrawnAt,
  ).not.toBeNull();
  await expect(
    admitPublicationRecord(
      f.record,
      f.draft,
      { ...f.request, id: crypto.randomUUID() },
      now,
    ),
  ).rejects.toThrow();
});
it.each(['wallet', 'revision', 'proof', 'history', 'receipt', 'gate'] as const)(
  'refuses publication when retained wallet evidence changes: %s',
  async (kind) => {
    const f = await marketplacePublicationFixture(now),
      inventory = structuredClone(f.inventory);
    if (kind === 'wallet') inventory.wallets[0].label = 'Changed';
    if (kind === 'revision') inventory.wallets[0].revision++;
    if (kind === 'proof') inventory.wallets[0].ownershipProofAt = null;
    if (kind === 'history') inventory.wallets[0].savedHistoryChecks++;
    if (kind === 'receipt') inventory.wallets[0].warmupReceiptCount++;
    if (kind === 'gate') Object.assign(inventory, { purchaseEnabled: true });
    await expect(reviewPublication(f.draft, inventory, now)).rejects.toThrow();
  },
);
it.each([
  'duplicate',
  'address',
  'balance',
  'time',
  'authority',
  'private',
] as const)('refuses invalid catalog response: %s', async (kind) => {
  const f = await marketplacePublicationFixture(now),
    c = structuredClone(f.catalog);
  if (kind === 'duplicate') c.listings.push(c.listings[0]);
  if (kind === 'address') c.listings[0].listing.address = 'x'.repeat(32);
  if (kind === 'balance')
    c.listings[0].listing.historicalBalance!.balanceLamports =
      '18446744073709551616';
  if (kind === 'time') c.expiresAt = new Date(now + 61000).toISOString();
  if (kind === 'authority') Object.assign(c, { purchaseEnabled: true });
  if (kind === 'private')
    Object.assign(c.listings[0], { owner_id: 'operator' });
  expect(() => admitBundleCatalog(c, now)).toThrow();
});
