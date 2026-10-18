import { expect, it } from 'vitest';
import { importedBalanceReviewFixture } from '../test/imported-balance-review-fixture';
import {
  importedBalanceBasisPointAmount,
  importedSupplyBasisPointAmount,
  importedSellPercentage,
  importedSupplySellAmount,
} from './imported-balance-review';
const now = Date.parse('2026-10-18T12:00:00.000Z');
it('uses exact custom balance percentages with conservative rounding and preserves old fixed whitelists', () => {
  const { report, context } = importedBalanceReviewFixture(now);
  expect(importedBalanceBasisPointAmount(report, context, 3333, now)).toBe(
    '0.001',
  );
  expect(importedBalanceBasisPointAmount(report, context, 10000, now)).toBe(
    '0.003003',
  );
  expect(() =>
    importedBalanceBasisPointAmount(report, context, 1, now),
  ).toThrow('atomic');
  expect(() => importedSellPercentage(report, context, 33.33, now)).toThrow();
  report.tokenRaw = report.unfrozenRaw = '18446744073709551615';
  report.frozenRaw = '0';
  expect(importedBalanceBasisPointAmount(report, context, 3333, now)).toBe(
    '6148299799767.393553',
  );
});
it('binds custom supply percentages to the saved mint and fresh supported holdings', () => {
  const { report, context } = importedBalanceReviewFixture(now),
    supply = {
      mint: context.mint,
      decimals: 6,
      totalSupplyRaw: '1000000',
      observedAt: new Date(now).toISOString(),
    };
  expect(importedSupplyBasisPointAmount(report, context, supply, 1, now)).toBe(
    '0.0001',
  );
  expect(() =>
    importedSupplySellAmount(report, context, supply, 1, now),
  ).toThrow();
  expect(() =>
    importedSupplyBasisPointAmount(report, context, supply, 10000, now),
  ).toThrow(/exceeds/);
  expect(() =>
    importedSupplyBasisPointAmount(
      report,
      context,
      { ...supply, mint: context.wallet },
      1,
      now,
    ),
  ).toThrow();
  for (const bps of [0, 10001, 1.2, NaN])
    expect(() =>
      importedBalanceBasisPointAmount(report, context, bps, now),
    ).toThrow();
  expect(() =>
    importedBalanceBasisPointAmount(report, context, 5000, now + 60000),
  ).toThrow();
  expect(() =>
    importedBalanceBasisPointAmount(
      { ...report, preparationSupported: false },
      context,
      5000,
      now,
    ),
  ).toThrow();
  expect(() =>
    importedBalanceBasisPointAmount(
      report,
      { ...context, wallet: context.mint },
      5000,
      now,
    ),
  ).toThrow();
});
