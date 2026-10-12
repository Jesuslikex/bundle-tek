import { expect, it } from 'vitest';
import {
  sizeSessionSellPercentage,
  sizeSessionSupplyPercentage,
} from './trade-session-sell-sizing';
import { importedWalletInventory } from './imported-wallet-inventory';
import { inventoryFixture } from '../test/imported-wallet-inventory-fixture';
const now = Date.parse('2026-10-11T00:00:30Z');
const snapshot = inventoryFixture(),
  wallets = [
    { address: snapshot.address, revision: 1 },
    { address: 'second-wallet', revision: 2 },
  ];
function items() {
  return wallets.map((w) =>
    importedWalletInventory(
      { ...inventoryFixture(), address: w.address },
      w.address,
      w.revision,
      snapshot.holdings[0].mint,
      6,
    ),
  );
}
const supply = {
  mint: snapshot.holdings[0].mint,
  decimals: 6,
  totalSupplyRaw: '1001000',
  observedAt: new Date(now).toISOString(),
};
it('allocates one supply total exactly with deterministic remainders independent of selection order', () => {
  const result = sizeSessionSupplyPercentage(items(), wallets, supply, 10, now);
  expect(result.totalRaw).toBe('1001');
  expect(result.totalAmount).toBe('0.001001');
  expect(result.amounts.toSorted()).toEqual(['0.0005', '0.000501']);
  expect(
    sizeSessionSupplyPercentage(
      items(),
      [...wallets].reverse(),
      supply,
      10,
      now,
    ).amounts,
  ).toEqual([...result.amounts].reverse());
});
it('allocates proportionally and never uses frozen units to cover a supply target', () => {
  const data = items();
  data[1].observation = {
    ...data[1].observation!,
    raw: '10009',
    unfrozenRaw: '9009',
    amount: '0.010009',
  };
  const result = sizeSessionSupplyPercentage(
    data,
    wallets,
    { ...supply, totalSupplyRaw: '1000000' },
    10,
    now,
  );
  expect(result.amounts).toEqual(['0.00025', '0.00075']);
  expect(() =>
    sizeSessionSupplyPercentage(
      items(),
      wallets,
      { ...supply, totalSupplyRaw: '7000000' },
      10,
      now,
    ),
  ).toThrow('enough unfrozen');
});
it('rejects stale or pre-finalization holdings and totals too small for all entries', () => {
  expect(() =>
    sizeSessionSupplyPercentage(items(), wallets, supply, 10, now + 60001),
  ).toThrow();
  expect(() =>
    sizeSessionSupplyPercentage(
      items(),
      wallets,
      supply,
      10,
      now,
      new Map([[wallets[0].address, now]]),
    ),
  ).toThrow('finalized');
  expect(() =>
    sizeSessionSupplyPercentage(
      items(),
      wallets,
      { ...supply, totalSupplyRaw: '1000' },
      10,
      now,
    ),
  ).toThrow('positive');
});
it('uses each selected wallet unfrozen units and floors independently in selection order', () => {
  const data = items();
  data[1].observation = {
    ...data[1].observation!,
    raw: '5005',
    unfrozenRaw: '4005',
    amount: '0.005005',
  };
  expect(sizeSessionSellPercentage(data, wallets, 6, 25, now)).toEqual([
    '0.00075',
    '0.001001',
  ]);
  expect(
    sizeSessionSellPercentage(data, [wallets[1], wallets[0]], 6, 100, now),
  ).toEqual(['0.004005', '0.003003']);
});
it('rejects all sizing when any selected wallet is missing, stale, changed or rounds to zero', () => {
  for (const patch of [
    null,
    { ...items()[0].observation!, observedAt: '2026-10-10T00:00:00Z' },
    { ...items()[0].observation!, observedAt: '2026-10-11T00:01:00Z' },
    {
      ...items()[0].observation!,
      raw: '1001',
      unfrozenRaw: '1',
      amount: '0.001001',
    },
  ]) {
    const data = items();
    data[0].observation = patch;
    expect(() =>
      sizeSessionSellPercentage(data, wallets, 6, 25, now),
    ).toThrow();
  }
  expect(() =>
    sizeSessionSellPercentage(
      items(),
      [{ ...wallets[0], revision: 3 }],
      6,
      25,
      now,
    ),
  ).toThrow();
  expect(() =>
    sizeSessionSellPercentage(items().slice(1), wallets, 6, 25, now),
  ).toThrow();
  expect(() => sizeSessionSellPercentage(items(), [], 6, 25, now)).toThrow();
  expect(() =>
    sizeSessionSellPercentage(items(), wallets, 6, 10, now),
  ).toThrow();
});
it('rechecks age and the finalized-receipt barrier at application time', () => {
  const data = items(),
    time = Date.parse(data[0].observation!.observedAt);
  expect(sizeSessionSellPercentage(data, wallets, 6, 50, time + 60000)).toEqual(
    ['0.001501', '0.001501'],
  );
  expect(() =>
    sizeSessionSellPercentage(data, wallets, 6, 50, time + 60001),
  ).toThrow('stale');
  expect(() =>
    sizeSessionSellPercentage(
      data,
      wallets,
      6,
      50,
      now,
      new Map([[wallets[0].address, time]]),
    ),
  ).toThrow('predates');
  data[0].observation!.observedAt = new Date(time + 1).toISOString();
  expect(
    sizeSessionSellPercentage(
      data,
      wallets,
      6,
      50,
      now,
      new Map([[wallets[0].address, time]]),
    ),
  ).toHaveLength(2);
});
