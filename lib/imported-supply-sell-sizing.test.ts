import { expect, it } from 'vitest';
import { importedSupplySellAmount } from './imported-balance-review';
import { importedBalanceReviewFixture } from '../test/imported-balance-review-fixture';
const now = Date.parse('2026-10-12T00:00:00Z');
const { report, context } = importedBalanceReviewFixture(now);
const supply = {
  mint: context.mint,
  decimals: 6,
  totalSupplyRaw: '1000003',
  observedAt: new Date(now).toISOString(),
};
it('rounds fractional supply percentages down with integer atoms', () => {
  expect(importedSupplySellAmount(report, context, supply, 10, now)).toBe(
    '0.001',
  );
});
it('rejects insufficient unfrozen units without using frozen holdings', () => {
  expect(() =>
    importedSupplySellAmount(
      report,
      context,
      { ...supply, totalSupplyRaw: '4000000' },
      10,
      now,
    ),
  ).toThrow('unfrozen');
  expect(() =>
    importedSupplySellAmount(report, context, supply, 50, now),
  ).toThrow('unfrozen');
});
it('rejects stale balances, unsupported inventory and foreign supply evidence', () => {
  expect(() =>
    importedSupplySellAmount(report, context, supply, 10, now + 60000),
  ).toThrow();
  expect(() =>
    importedSupplySellAmount(
      { ...report, preparationSupported: false },
      context,
      supply,
      10,
      now,
    ),
  ).toThrow();
  for (const changed of [
    { ...supply, mint: 'foreign' },
    { ...supply, decimals: 9 },
    { ...supply, observedAt: 'invalid' },
  ])
    expect(() =>
      importedSupplySellAmount(report, context, changed, 10, now),
    ).toThrow();
});
it('rejects malformed raw supply, unsupported percentages and sub-atom amounts', () => {
  for (const totalSupplyRaw of ['0', '01', '-1', '18446744073709551616'])
    expect(() =>
      importedSupplySellAmount(
        report,
        context,
        { ...supply, totalSupplyRaw },
        10,
        now,
      ),
    ).toThrow();
  expect(() =>
    importedSupplySellAmount(report, context, supply, 11, now),
  ).toThrow();
  expect(() =>
    importedSupplySellAmount(
      report,
      context,
      { ...supply, totalSupplyRaw: '1' },
      10,
      now,
    ),
  ).toThrow('atomic');
});
it('preserves exact precision at the maximum u64 supply', () => {
  const max = '18446744073709551615';
  expect(
    importedSupplySellAmount(
      { ...report, tokenRaw: max, unfrozenRaw: max, frozenRaw: '0' },
      context,
      { ...supply, totalSupplyRaw: max },
      500,
      now,
    ),
  ).toBe('922337203685.47758');
});
