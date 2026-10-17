import { expect, it } from 'vitest';
import {
  marketplaceFilters,
  marketplaceSol,
  selectMarketplaceInventory,
} from './marketplace-catalog';
import { marketplaceFixture } from '../test/marketplace-fixture';
const now = Date.parse('2026-10-17T12:00:00Z');
const filters = marketplaceFilters.parse({});
it('filters real supplied entries and preserves partial coverage without inventing inventory', () => {
  const result = selectMarketplaceInventory(
    marketplaceFixture(now),
    marketplaceFilters.parse({ source: 'Classic' }),
    now,
  );
  expect(result.listings.map((v) => v.id)).toEqual(['wallet-1', 'wallet-2']);
  expect(result).toMatchObject({
    coverage: 'partial',
    inventoryCount: 3,
    matchingCount: 2,
    purchaseEnabled: false,
    totalBalanceLamports: '2000000000',
    totalPriceLamports: '2200000001',
    netCostLamports: '200000001',
  });
  expect(
    selectMarketplaceInventory(
      marketplaceFixture(now),
      marketplaceFilters.parse({ minimumAgeDays: 10 }),
      now,
    ).listings,
  ).toEqual([]);
});
it('applies spacing to the cheapest-first shortlist, not a false full-match count', () => {
  const result = selectMarketplaceInventory(
    marketplaceFixture(now),
    marketplaceFilters.parse({ minimumGapMinutes: 120 }),
    now,
  );
  expect(result.matchingCount).toBe(3);
  expect(result.listings.map((v) => v.id)).toEqual(['wallet-1', 'wallet-3']);
});
it('keeps amounts beyond Number precision exact, including negative price less balance', () => {
  const data = marketplaceFixture(now);
  data.listings = [data.listings[0]];
  data.listings[0].balanceLamports = '9007199254740993';
  data.listings[0].purchasePriceLamports = '9007199254740992';
  const result = selectMarketplaceInventory(data, filters, now);
  expect(result.netCostLamports).toBe('-1');
  expect(marketplaceSol(result.totalBalanceLamports)).toBe('9007199.254740993');
  expect(marketplaceSol('-1')).toBe('-0.000000001');
});
it('refuses duplicate identities, private-key fields, future funding and stale snapshots', () => {
  const duplicate = marketplaceFixture(now);
  duplicate.listings[1].address = duplicate.listings[0].address;
  expect(() => selectMarketplaceInventory(duplicate, filters, now)).toThrow();
  const secret = marketplaceFixture(now);
  expect(() =>
    selectMarketplaceInventory(
      { ...secret, privateKey: 'never-forward' },
      filters,
      now,
    ),
  ).toThrow();
  const future = marketplaceFixture(now);
  future.listings[0].fundedAt = new Date(now + 1).toISOString();
  expect(() => selectMarketplaceInventory(future, filters, now)).toThrow();
  expect(() =>
    selectMarketplaceInventory(marketplaceFixture(now - 60000), filters, now),
  ).toThrow();
  expect(() =>
    selectMarketplaceInventory(marketplaceFixture(now + 1), filters, now),
  ).toThrow();
});
it('rejects unsupported filters and negative, exponent or overflowing amount strings', () => {
  for (const query of [
    { count: 500 },
    { chain: 'Ethereum' },
    { endpoint: 'https://attacker.example.com' },
    { minimumAgeDays: 0 },
    { minimumBalanceLamports: '-1' },
    { maximumPriceLamports: '1e9' },
    { minimumBalanceLamports: '18446744073709551616' },
  ])
    expect(marketplaceFilters.safeParse(query).success).toBe(false);
});
