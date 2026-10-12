import { it, expect } from 'vitest';
import { summarizeAccountCosts, validatedAccountCosts } from './account-costs';
const coverage = {
  pendingCount: 0,
  missingFailureCount: 0,
  missingFinalizedCount: 0,
};
it('preserves exact combined fees above uint64 and rejects duplicate transactions and changed totals', () => {
  const fee = ((1n << 64n) - 1n).toString();
  const result = summarizeAccountCosts(
    [
      {
        category: 'Imported swaps',
        signature: 'one',
        outcome: 'success',
        feeLamports: fee,
      },
      {
        category: 'Withdrawals',
        signature: 'two',
        outcome: 'failed',
        feeLamports: fee,
      },
    ],
    coverage,
    '2026-10-11T00:00:00Z',
  );
  expect(result.totalFeeLamports).toBe((2n * BigInt(fee)).toString());
  expect(validatedAccountCosts(result)).toBe(result);
  expect(() => validatedAccountCosts({ ...result, receiptCount: 1 })).toThrow();
  expect(() =>
    validatedAccountCosts({ ...result, failedFeeLamports: '0' }),
  ).toThrow();
  expect(() =>
    summarizeAccountCosts(
      [
        {
          category: 'Imported swaps',
          signature: 'one',
          outcome: 'success',
          feeLamports: '1',
        },
        {
          category: 'Withdrawals',
          signature: 'one',
          outcome: 'failed',
          feeLamports: '1',
        },
      ],
      coverage,
      result.observedAt,
    ),
  ).toThrow();
});
