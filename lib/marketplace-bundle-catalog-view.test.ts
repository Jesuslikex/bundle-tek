import { expect, it } from 'vitest';
import {
  filterBundleCatalog,
  EMPTY_BUNDLE_CATALOG_FILTERS as empty,
} from './marketplace-bundle-catalog-view';
import type { BundleCatalog } from './marketplace-publication';
const observedAt = '2026-10-23T12:00:00Z';
function catalog() {
  const listing = (
    id: string,
    days: number | null,
    balance: string | null,
  ) => ({
    id,
    publishedAt: observedAt,
    listing: {
      address: id,
      priceLamports: '1000000000',
      oldestRecordedActivityAt:
        days === null
          ? null
          : new Date(Date.parse(observedAt) - days * 86400000).toISOString(),
      historicalBalance:
        balance === null
          ? null
          : {
              balanceLamports: balance,
              observedAt: '2026-10-01T00:00:00Z',
              sampleCount: 1,
              successfulSampleCount: 1,
            },
      savedHistoryChecks: 3,
      warmupUniqueSignatures: 5,
    },
  });
  // This pure view operates on admitted catalogs; authority admission is tested elsewhere.
  return {
    observedAt,
    listings: [
      listing('c', null, null),
      listing('b', 2, '9007199254740993'),
      listing('a', 1, '9007199254740992'),
    ],
  } as unknown as BundleCatalog;
}
it('uses inclusive snapshot-relative ages and excludes unknown dates when bounded', () => {
  const c = catalog();
  expect(
    filterBundleCatalog(
      c,
      { ...empty, minimumAge: '1', maximumAge: '2' },
      'activity',
    ).listings.map((e) => e.id),
  ).toEqual(['b', 'a']);
  expect(
    filterBundleCatalog(c, { ...empty, maximumAge: '0' }, 'activity').listings,
  ).toEqual([]);
  expect(c.listings[1].listing.historicalBalance!.observedAt).toBe(
    '2026-10-01T00:00:00Z',
  );
});
it('compares historical lamports exactly above safe integers and keeps unknowns last in both directions', () => {
  const c = catalog();
  expect(
    filterBundleCatalog(
      c,
      {
        ...empty,
        minimumBalance: '9007199.254740993',
        maximumBalance: '9007199.254740993',
      },
      'price',
    ).listings.map((e) => e.id),
  ).toEqual(['b']);
  expect(
    filterBundleCatalog(c, empty, 'balance-low').listings.map((e) => e.id),
  ).toEqual(['a', 'b', 'c']);
  expect(
    filterBundleCatalog(c, empty, 'balance-high').listings.map((e) => e.id),
  ).toEqual(['b', 'a', 'c']);
  expect(
    filterBundleCatalog(c, { ...empty, minimumBalance: '0' }, 'price').listings,
  ).toHaveLength(2);
});
it('matches exact case-sensitive addresses and inclusive evidence counts without mutating source order', () => {
  const c = catalog();
  expect(
    filterBundleCatalog(
      c,
      { ...empty, address: 'a', minimumChecks: '3', minimumSignatures: '5' },
      'price',
    ).listings.map((e) => e.id),
  ).toEqual(['a']);
  expect(
    filterBundleCatalog(c, { ...empty, address: 'A' }, 'price').listings,
  ).toEqual([]);
  expect(
    filterBundleCatalog(c, { ...empty, minimumChecks: '4' }, 'price').listings,
  ).toEqual([]);
  expect(
    filterBundleCatalog(c, { ...empty, minimumSignatures: '6' }, 'price')
      .listings,
  ).toEqual([]);
  expect(c.listings.map((e) => e.id)).toEqual(['c', 'b', 'a']);
});
it('uses deterministic identity ties for equal prices and balances', () => {
  const c = catalog();
  c.listings[1].listing.historicalBalance!.balanceLamports =
    c.listings[2].listing.historicalBalance!.balanceLamports;
  expect(
    filterBundleCatalog(c, empty, 'price').listings.map((e) => e.id),
  ).toEqual(['a', 'b', 'c']);
  expect(
    filterBundleCatalog(c, empty, 'balance-high').listings.map((e) => e.id),
  ).toEqual(['a', 'b', 'c']);
});
it.each([
  { minimumAge: '01' },
  { maximumAge: '36501' },
  { minimumAge: '2', maximumAge: '1' },
  { minimumBalance: '2', maximumBalance: '1' },
  { maximumPrice: '1e2' },
  { minimumBalance: '0.0000000001' },
  { minimumBalance: '-1' },
  { maximumBalance: ' 1' },
  { minimumChecks: '1.0' },
  { minimumSignatures: '9007199254740992' },
  { address: 'a'.repeat(45) },
])('refuses malformed or reversed filters %j', (changed) => {
  expect(
    filterBundleCatalog(catalog(), { ...empty, ...changed }, 'price'),
  ).toEqual({ listings: [], valid: false });
});
