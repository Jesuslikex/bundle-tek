import { it, expect } from 'vitest';
import { importedBalanceReviewFixture } from '../test/imported-balance-review-fixture';
import {
  importedSellPercentage,
  validatedImportedBalance,
} from './imported-balance-review';
const now = Date.parse('2026-10-11T09:00:00Z');
it('uses only unfrozen raw inventory and rounds percentage amounts down without changing the observation', () => {
  const { report, context } = importedBalanceReviewFixture(now),
    original = structuredClone(report);
  expect(
    [25, 50, 75, 100].map((p) =>
      importedSellPercentage(report, context, p, now),
    ),
  ).toEqual(['0.00075', '0.001501', '0.002252', '0.003003']);
  expect(report).toEqual(original);
  report.token2022 = true;
  report.mintExtensions = ['metadataPointer'];
  report.mintSlot = 101;
  expect(importedSellPercentage(report, context, 100, now)).toBe('0.003003');
});
it('preserves u64 precision, zero-decimal amounts and percentages below one atomic unit', () => {
  const { report, context } = importedBalanceReviewFixture(now);
  report.tokenRaw = report.unfrozenRaw = '18446744073709551615';
  report.frozenRaw = '0';
  expect(importedSellPercentage(report, context, 50, now)).toBe(
    '9223372036854.775807',
  );
  context.tokenDecimals = report.decimals = 0;
  expect(importedSellPercentage(report, context, 100, now)).toBe(
    '18446744073709551615',
  );
  report.tokenRaw =
    report.unfrozenRaw =
    report.requestedRaw =
    context.requestedRaw =
      '1';
  expect(() => importedSellPercentage(report, context, 25, now)).toThrow(
    'one atomic unit',
  );
  expect(importedSellPercentage(report, context, 100, now)).toBe('1');
});
it('rejects context changes, malformed inventory, coverage contradictions and incoherent slots', () => {
  for (const mutation of [
    { wallet: 'other' },
    { mint: 'other' },
    { side: 'Buy' },
    { requestedRaw: '2' },
    { decimals: 9 },
    { executionAllowed: true },
    { inventoryScope: 'wallet' },
    { unfrozenRaw: '3004' },
    { shortfallRaw: '1' },
    { amountCovered: false },
    { nativeRaw: '18446744073709551616' },
    { tokenRaw: '04003' },
    { minSlot: 102 },
    { nativeSlot: 99 },
    { mintSlot: 200 },
    { expiresAt: new Date(now + 60001).toISOString() },
  ]) {
    const { report, context } = importedBalanceReviewFixture(now);
    expect(() =>
      validatedImportedBalance({ ...report, ...mutation }, context, now),
    ).toThrow();
  }
});
it('requires fresh supported inventory at the instant of selection and excludes zero, arbitrary percentages and buys', () => {
  const { report, context } = importedBalanceReviewFixture(now);
  expect(() =>
    importedSellPercentage(report, context, 100, now + 60000),
  ).toThrow('Fresh');
  expect(() =>
    importedSellPercentage(
      {
        ...report,
        preparationSupported: false,
        blockedExtensions: ['mint: transferFeeConfig'],
      },
      context,
      100,
      now,
    ),
  ).toThrow('Fresh');
  expect(() => importedSellPercentage(report, context, 99, now)).toThrow();
  const buy = { ...report, side: 'Buy' as const, decimals: 9 };
  expect(() =>
    importedSellPercentage(buy, { ...context, side: 'Buy' }, 25, now),
  ).toThrow();
});
