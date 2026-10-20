import { it, expect } from 'vitest';
import { launchSaleCosts } from './launch-sale-performance';

const origin = 'c'.repeat(64),
  sourceHash = 'd'.repeat(64);
const source = (cost: string | null, acquiredRaw = '3') => ({
  originId: origin,
  wallet: 'W',
  mint: 'M',
  sha256: sourceHash,
  source: JSON.stringify({
    originId: origin,
    wallet: 'W',
    mint: 'M',
    sha256: sourceHash,
    acquiredRaw,
    nativeTradeCostExcludingSetupLamports: cost,
    policy: 'reviewed-buy-shares-v1',
    acquisitionBasisVerified: false,
    executionAllowed: false,
  }),
});
const sale = (
  n: number,
  beforeRaw: string,
  unitsRaw: string,
  afterRaw: string,
) => {
  const sha256 = String(n).repeat(64);
  return {
    saleReceiptId: `sale-${n}`,
    saleSignature: `sig-${n}`,
    wallet: 'W',
    mint: 'M',
    sha256,
    document: JSON.stringify({
      format: 'launch-sale-allocation-v1',
      policy: 'recorded-launch-units-v1',
      saleReceiptId: `sale-${n}`,
      saleSignature: `sig-${n}`,
      wallet: 'W',
      mint: 'M',
      decimals: 6,
      soldRaw: unitsRaw,
      allocations: [
        {
          originId: origin,
          sourceSha256: sourceHash,
          beforeRaw,
          unitsRaw,
          afterRaw,
        },
      ],
      executionAllowed: false,
      profitCalculated: false,
      sha256,
    }),
  };
};

it('splits one buy cost across sequential sales so shares sum exactly to the buy cost', () => {
  const { costs, unvalued } = launchSaleCosts(
    [sale(1, '0', '1', '1'), sale(2, '1', '1', '2'), sale(3, '2', '1', '3')],
    [source('100')],
  );
  expect(unvalued.size).toBe(0);
  const shares = [1, 2, 3].map((n) => costs.get(`sale-${n}`)!.costLamports);
  expect(shares).toEqual(['33', '33', '34']);
  expect(shares.reduce((n, s) => n + BigInt(s), 0n)).toBe(100n);
});
it('marks token-quote buys as unvalued instead of inventing a SOL cost', () => {
  const { costs, unvalued } = launchSaleCosts(
    [sale(1, '0', '1', '1')],
    [source(null)],
  );
  expect(costs.size).toBe(0);
  expect([...unvalued]).toEqual(['sale-1']);
});
it('refuses missing sources, overrun intervals and altered source hashes', () => {
  expect(() => launchSaleCosts([sale(1, '0', '1', '1')], [])).toThrow();
  expect(() =>
    launchSaleCosts([sale(1, '2', '2', '4')], [source('100')]),
  ).toThrow();
  expect(() =>
    launchSaleCosts([sale(1, '0', '1', '2')], [source('100')]),
  ).toThrow();
  const altered = source('100');
  altered.sha256 = 'e'.repeat(64);
  expect(() => launchSaleCosts([sale(1, '0', '1', '1')], [altered])).toThrow();
});
