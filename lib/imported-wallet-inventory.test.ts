import { expect, it } from 'vitest';
import {
  importedWalletInventory,
  inventoryRetainedRefresh,
  validatedInventoryItems,
  inventorySupplyShare,
} from './imported-wallet-inventory';
import { inventoryFixture } from '../test/imported-wallet-inventory-fixture';
import {
  acquisitionWallet as wallet,
  acquisitionMint as mint,
} from '../test/imported-sell-acquisition-fixture';
it('distinguishes unknown holdings from proven zero and keeps exact frozen inventory', () => {
  expect(
    importedWalletInventory(null, wallet, 1, mint, 6).observation,
  ).toBeNull();
  const fixture = inventoryFixture();
  expect(
    importedWalletInventory(fixture, wallet, 1, mint, 6).observation,
  ).toMatchObject({
    raw: '4003',
    frozenRaw: '1000',
    unfrozenRaw: '3003',
    amount: '0.004003',
  });
  fixture.holdings = [];
  fixture.accountCount = 0;
  expect(
    importedWalletInventory(fixture, wallet, 1, mint, 6).observation?.raw,
  ).toBe('0');
  expect(inventorySupplyShare('4003', '1000000')).toBe('0.4003%');
  expect(inventorySupplyShare('1', '18446744073709551615')).toBe('<0.0001%');
  expect(inventorySupplyShare('1', '0')).toBeNull();
  expect(inventorySupplyShare('2', '1')).toBeNull();
});
it('rejects incomplete program/account coverage, duplicate evidence and wrong mint precision', () => {
  for (const mutate of [
    (s: ReturnType<typeof inventoryFixture>) => s.slots.pop(),
    (s: ReturnType<typeof inventoryFixture>) => s.accountCount++,
    (s: ReturnType<typeof inventoryFixture>) =>
      s.holdings[0].accounts.push(s.holdings[0].accounts[0]),
    (s: ReturnType<typeof inventoryFixture>) => s.holdings.push(s.holdings[0]),
    (s: ReturnType<typeof inventoryFixture>) => (s.holdings[0].raw = '4004'),
    (s: ReturnType<typeof inventoryFixture>) => (s.holdings[0].decimals = 5),
    (s: ReturnType<typeof inventoryFixture>) => (s.address = 'another-wallet'),
    (s: ReturnType<typeof inventoryFixture>) => (s.holdings[0].amount = '4003'),
    (s: ReturnType<typeof inventoryFixture>) => (s.maxSlot = 252),
  ]) {
    const s = inventoryFixture();
    mutate(s);
    expect(() => importedWalletInventory(s, wallet, 1, mint, 6)).toThrow();
  }
});
it('checks every client wallet revision, uniqueness and exact inventory arithmetic', () => {
  const item = importedWalletInventory(inventoryFixture(), wallet, 1, mint, 6),
    rows = [{ address: wallet, revision: 1 }];
  expect(validatedInventoryItems([item], rows, 6)).toEqual([item]);
  for (const changed of [
    [],
    [item, item],
    [{ ...item, walletRevision: 2 }],
    [{ ...item, observation: { ...item.observation!, frozenRaw: '999' } }],
    [{ ...item, observation: { ...item.observation!, amount: '4' } }],
  ])
    expect(() => validatedInventoryItems(changed, rows, 6)).toThrow();
});

it('clears freshness only for the same retained wallet revision and complete observation', () => {
  const fresh = importedWalletInventory(inventoryFixture(), wallet, 1, mint, 6);
  expect(inventoryRetainedRefresh([fresh], fresh)).toBe(true);
  expect(inventoryRetainedRefresh([], fresh)).toBe(false);
  expect(
    inventoryRetainedRefresh([{ ...fresh, observation: null }], fresh),
  ).toBe(false);
  expect(
    inventoryRetainedRefresh([{ ...fresh, walletRevision: 2 }], fresh),
  ).toBe(false);
  for (const key of [
    'raw',
    'frozenRaw',
    'unfrozenRaw',
    'amount',
    'observedAt',
    'minSlot',
    'maxSlot',
    'source',
  ] as const) {
    const observation = { ...fresh.observation! };
    Object.assign(observation, {
      [key]:
        typeof observation[key] === 'number'
          ? Number(observation[key]) + 1
          : 'different',
    });
    expect(inventoryRetainedRefresh([{ ...fresh, observation }], fresh)).toBe(
      false,
    );
  }
});
