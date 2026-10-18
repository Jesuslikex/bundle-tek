import { expect, it } from 'vitest';
import {
  marketplaceFilters,
  marketplaceSol,
  marketplaceLamports,
  selectMarketplaceInventory,
  sortMarketplaceListings,
} from './marketplace-catalog';
import { marketplaceFixture } from '../test/marketplace-fixture';
const now = Date.parse('2026-10-17T12:00:00Z');
const filters = marketplaceFilters.parse({});
it('admits custom quantities within the existing 200-wallet ceiling and preserves default/legacy filters', () => {
  for (const count of [1, 7, 25, 42, 50, 100, 199, 200])
    expect(marketplaceFilters.parse({ count }).count).toBe(count);
  for (const count of [0, -1, 1.5, 201, NaN, Infinity])
    expect(marketplaceFilters.safeParse({ count }).success).toBe(false);
  expect(marketplaceFilters.parse({}).count).toBe(25);
  expect(
    JSON.stringify(
      marketplaceFilters.parse({ source: 'Classic', tier: 'light-history' }),
    ),
  ).not.toMatch(/sources|tiers/);
});
it('applies multiple reported sources and tiers before count, spacing and exact totals', () => {
  const data = marketplaceFixture(now);
  data.listings[0].tier = 'funding-only';
  data.listings[2].tier = 'established';
  const selected = marketplaceFilters.parse({
    count: 2,
    sources: JSON.stringify(['Exchange', 'Classic']),
    tiers: JSON.stringify(['established', 'funding-only']),
  });
  const result = selectMarketplaceInventory(data, selected, now);
  expect(result.filters.sources).toEqual(['Classic', 'Exchange']);
  expect(result.listings.map((row) => row.id)).toEqual([
    'wallet-1',
    'wallet-3',
  ]);
  expect(result.matchingCount).toBe(2);
  expect(result.purchaseEnabled).toBe(false);
  expect(result.totalPriceLamports).toBe('2200000002');
  expect(
    selectMarketplaceInventory(
      data,
      marketplaceFilters.parse({ sources: ['Absent'] }),
      now,
    ).listings,
  ).toEqual([]);
});
it('rejects conflicting legacy/multiple filters, duplicates and malformed or oversized arrays', () => {
  for (const query of [
    { source: 'Classic', sources: ['Classic'] },
    { tier: 'light-history', tiers: ['light-history'] },
    { sources: [] },
    { sources: ['Classic', 'Classic'] },
    { sources: Array.from({ length: 21 }, (_, i) => String(i)) },
    { tiers: ['unknown'] },
    { tiers: ['established', 'established'] },
    { sources: 'not json' },
    { sources: '{}' },
    { tiers: '[]' },
  ])
    expect(marketplaceFilters.safeParse(query).success).toBe(false);
});
it('sorts exact displayed values without mutating selection or losing one-lamport differences', () => {
  const rows = marketplaceFixture(now).listings;
  rows[0].purchasePriceLamports = '9007199254740993';
  rows[1].purchasePriceLamports = '9007199254740992';
  rows[2].purchasePriceLamports = '1';
  rows[2].balanceLamports = '2';
  const before = JSON.stringify(rows);
  expect(
    sortMarketplaceListings(rows, 'price', false).map((row) => row.id),
  ).toEqual(['wallet-3', 'wallet-2', 'wallet-1']);
  expect(
    sortMarketplaceListings(rows, 'price', true).map((row) => row.id),
  ).toEqual(['wallet-1', 'wallet-2', 'wallet-3']);
  expect(sortMarketplaceListings(rows, 'net', false)[0].id).toBe('wallet-3');
  expect(sortMarketplaceListings(rows, 'funded', false)[0].id).toBe('wallet-3');
  expect(
    sortMarketplaceListings(rows, 'transactions', false).map((row) => row.id),
  ).toEqual(['wallet-1', 'wallet-2', 'wallet-3']);
  expect(JSON.stringify(rows)).toBe(before);
});
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
it('applies inclusive age, balance and transaction ranges before shortlist totals', () => {
  const data = marketplaceFixture(now);
  data.listings[0].transactionCount = 0;
  data.listings[1].transactionCount = 12;
  data.listings[2].transactionCount = 13;
  data.listings[1].balanceLamports = '9007199254740993';
  data.listings[2].balanceLamports = '9007199254740994';
  const result = selectMarketplaceInventory(
    data,
    marketplaceFilters.parse({
      minimumBalanceLamports: '9007199254740993',
      maximumBalanceLamports: '9007199254740993',
      minimumTransactions: 12,
      maximumTransactions: 12,
      maximumAgeDays: 4,
    }),
    now,
  );
  expect(result.listings.map((v) => v.id)).toEqual(['wallet-2']);
  expect(result.matchingCount).toBe(1);
  expect(result.totalBalanceLamports).toBe('9007199254740993');
  expect(
    selectMarketplaceInventory(
      data,
      marketplaceFilters.parse({ maximumAgeDays: 3 }),
      now,
    ).listings.map((v) => v.id),
  ).toEqual(['wallet-1']);
  expect(
    selectMarketplaceInventory(
      data,
      marketplaceFilters.parse({ maximumTransactions: 0 }),
      now,
    ).listings.map((v) => v.id),
  ).toEqual(['wallet-1']);
});
it.each([
  { minimumAgeDays: 3, maximumAgeDays: 2 },
  { minimumBalanceLamports: '10', maximumBalanceLamports: '9' },
  { minimumTransactions: 3, maximumTransactions: 2 },
  { maximumTransactions: -1 },
  { minimumTransactions: 1.5 },
  { maximumTransactions: Number.MAX_SAFE_INTEGER + 1 },
  { maximumBalanceLamports: '1e9' },
  { minimumBalanceLamports: 'invalid' },
])('refuses inverted or malformed advanced ranges: %j', (input) => {
  expect(marketplaceFilters.safeParse(input).success).toBe(false);
});
it('converts SOL filters exactly without rounding or exponent notation', () => {
  expect(marketplaceLamports('0.000000001')).toBe('1');
  expect(marketplaceLamports('9007199.254740993')).toBe('9007199254740993');
  expect(marketplaceLamports('18446744073.709551615')).toBe(
    '18446744073709551615',
  );
  for (const value of [
    '-1',
    '1e-9',
    '0.0000000001',
    '18446744073.709551616',
    '01',
    'NaN',
  ])
    expect(() => marketplaceLamports(value)).toThrow();
});
