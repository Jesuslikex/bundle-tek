import type { BundleCatalog } from './marketplace-publication';
import { marketplaceLamports } from './marketplace-catalog';

export type BundleCatalogFilters = {
  address: string;
  minimumAge: string;
  maximumAge: string;
  maximumPrice: string;
  minimumBalance: string;
  maximumBalance: string;
  minimumChecks: string;
  minimumSignatures: string;
};
export const EMPTY_BUNDLE_CATALOG_FILTERS: BundleCatalogFilters = {
  address: '',
  minimumAge: '0',
  maximumAge: '',
  maximumPrice: '',
  minimumBalance: '',
  maximumBalance: '',
  minimumChecks: '0',
  minimumSignatures: '0',
};
export type BundleCatalogSort =
  | 'price'
  | 'activity'
  | 'balance-low'
  | 'balance-high';

function whole(value: string, maximum: number) {
  if (!/^(0|[1-9]\d{0,15})$/.test(value)) throw Error();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) throw Error();
  return number;
}
function sol(value: string) {
  if (value === '') return null;
  return BigInt(marketplaceLamports(value));
}
/** Local display filtering of an already admitted snapshot; grants no authority. */
export function filterBundleCatalog(
  catalog: BundleCatalog | null,
  filters: BundleCatalogFilters,
  sort: BundleCatalogSort,
) {
  try {
    const minimumAge = whole(filters.minimumAge, 36500),
      maximumAge =
        filters.maximumAge === '' ? null : whole(filters.maximumAge, 36500),
      minimumChecks = whole(filters.minimumChecks, Number.MAX_SAFE_INTEGER),
      minimumSignatures = whole(
        filters.minimumSignatures,
        Number.MAX_SAFE_INTEGER,
      ),
      price = sol(filters.maximumPrice),
      minimumBalance = sol(filters.minimumBalance),
      maximumBalance = sol(filters.maximumBalance);
    if (
      (maximumAge !== null && maximumAge < minimumAge) ||
      (minimumBalance !== null &&
        maximumBalance !== null &&
        maximumBalance < minimumBalance)
    )
      throw Error();
    // Search is exact and case-sensitive. A partial address simply has no match.
    if (filters.address.length > 44) throw Error();
    const at = catalog ? Date.parse(catalog.observedAt) : 0;
    const listings = (catalog?.listings ?? []).filter(({ listing: e }) => {
      const age =
        e.oldestRecordedActivityAt === null
          ? null
          : at - Date.parse(e.oldestRecordedActivityAt);
      const balance =
        e.historicalBalance === null
          ? null
          : BigInt(e.historicalBalance.balanceLamports);
      return (
        (!filters.address || e.address === filters.address) &&
        (minimumAge === 0 || (age !== null && age >= minimumAge * 86400000)) &&
        (maximumAge === null ||
          (age !== null && age <= maximumAge * 86400000)) &&
        (price === null || BigInt(e.priceLamports) <= price) &&
        (minimumBalance === null ||
          (balance !== null && balance >= minimumBalance)) &&
        (maximumBalance === null ||
          (balance !== null && balance <= maximumBalance)) &&
        e.savedHistoryChecks >= minimumChecks &&
        e.warmupUniqueSignatures >= minimumSignatures
      );
    });
    listings.sort((a, b) => {
      const tie = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      if (sort === 'activity') {
        const av = a.listing.oldestRecordedActivityAt,
          bv = b.listing.oldestRecordedActivityAt;
        if (av === null || bv === null)
          return av === bv ? tie : av === null ? 1 : -1;
        return Date.parse(av) - Date.parse(bv) || tie;
      }
      if (sort === 'balance-low' || sort === 'balance-high') {
        const av = a.listing.historicalBalance,
          bv = b.listing.historicalBalance;
        if (av === null || bv === null)
          return av === bv ? tie : av === null ? 1 : -1;
        const x = BigInt(av.balanceLamports),
          y = BigInt(bv.balanceLamports);
        return x === y
          ? tie
          : (x < y ? -1 : 1) * (sort === 'balance-high' ? -1 : 1);
      }
      const x = BigInt(a.listing.priceLamports),
        y = BigInt(b.listing.priceLamports);
      return x === y ? tie : x < y ? -1 : 1;
    });
    return { listings, valid: true };
  } catch {
    return { listings: [], valid: false };
  }
}
