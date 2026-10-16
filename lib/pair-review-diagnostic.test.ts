import { expect, it } from 'vitest';
import {
  pairDiagnosticComparisons,
  pairReviewDiagnostic,
} from './pair-review-diagnostic';

it('retains exact before/after u64 values beyond Number precision in a private diagnostic', () => {
  const comparisons = pairDiagnosticComparisons(
    { nativeBalanceRaw: '18446744073709551615', reserveRaw: 9007199254740993n },
    { nativeBalanceRaw: '18446744073709551614', reserveRaw: 9007199254740992n },
  );
  expect(comparisons).toEqual([
    {
      field: 'nativeBalanceRaw',
      before: '18446744073709551615',
      after: '18446744073709551614',
    },
    {
      field: 'reserveRaw',
      before: '9007199254740993',
      after: '9007199254740992',
    },
  ]);
  const error = pairReviewDiagnostic(
    Error('public refusal'),
    'system-wallet-state',
    { comparisons },
  );
  expect(error.message).toBe('public refusal');
  expect(Object.keys(error)).not.toContain('pairDiagnostic');
  expect(JSON.stringify(error)).not.toContain('184467');
});

it('records missing fields explicitly rather than replacing their values with zero', () => {
  expect(pairDiagnosticComparisons({ sourceRaw: '0' }, {})).toEqual([
    { field: 'sourceRaw', before: '0', after: '<unavailable>' },
  ]);
});
