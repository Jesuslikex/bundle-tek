import { beforeAll, afterAll, expect, it } from 'vitest';
import { autoBuyBudgetFixture } from '../test/auto-buy-budget-fixture';
import {
  AUTO_BUY_BUDGET_AUTHORITY,
  AUTO_BUY_BUDGET_MAX,
  autoBuyBudgetAmount,
  autoBuyBudgetClaim,
  autoBuyBudgetTerms,
} from './auto-buy-budget';
let f: ReturnType<typeof autoBuyBudgetFixture>;
beforeAll(() => {
  f = autoBuyBudgetFixture({ full: false });
});
afterAll(() => f.sqlite.close());
it.each(['-1', '01', '1.0', '1e3', '9007199254740992', 1, null, undefined])(
  'refuses non-exact lamport input %s',
  (value) => {
    expect(() => autoBuyBudgetAmount(value)).toThrow();
  },
);
it('keeps the exact maximum integer, a separate fee cap and detached canonical input', () => {
  const terms = f.terms();
  terms.maximumInputLamports = AUTO_BUY_BUDGET_MAX.toString();
  terms.maximumFeeAndRentLamports = '0';
  terms.wallets[0].maximumFeeAndRentLamports = '0';
  for (const s of terms.strategies) s.maximumFeeAndRentLamports = '0';
  const saved = autoBuyBudgetTerms(terms);
  terms.wallets[0].maximumInputLamports = '1';
  expect(saved.maximumInputLamports).toBe('9007199254740991');
  expect(saved.wallets[0].maximumInputLamports).toBe('100');
  expect(Object.isFrozen(AUTO_BUY_BUDGET_AUTHORITY)).toBe(true);
  expect(
    Object.values(AUTO_BUY_BUDGET_AUTHORITY).every((v) => v === false),
  ).toBe(true);
});
it.each([
  'combined-overflow',
  'same-input-output',
  'duplicate-wallet',
  'duplicate-strategy',
  'wallet-overrun',
  'strategy-overrun',
  'empty-wallets',
  'unknown-field',
  'bad-revision',
  'bad-date',
] as const)('refuses invalid terms: %s', (kind) => {
  const v = f.terms();
  if (kind === 'same-input-output')
    v.mint = 'So11111111111111111111111111111111111111112';
  if (kind === 'combined-overflow') {
    v.maximumInputLamports = AUTO_BUY_BUDGET_MAX.toString();
    v.maximumFeeAndRentLamports = '1';
  }
  if (kind === 'duplicate-wallet')
    v.wallets.push(structuredClone(v.wallets[0]));
  if (kind === 'duplicate-strategy')
    v.strategies.push(structuredClone(v.strategies[0]));
  if (kind === 'wallet-overrun') v.wallets[0].maximumInputLamports = '101';
  if (kind === 'strategy-overrun')
    v.strategies[0].maximumFeeAndRentLamports = '21';
  if (kind === 'empty-wallets') v.wallets = [];
  if (kind === 'unknown-field') Object.assign(v, { approved: true });
  if (kind === 'bad-revision') v.wallets[0].revision = 1.5;
  if (kind === 'bad-date') v.expiresAt = '2026-10-21T00:00:00+00:00';
  expect(() => autoBuyBudgetTerms(v)).toThrow();
});
it.each([
  'token-overflow',
  'cycle-overflow',
  'zero-output',
  'unknown-field',
  'wrong-counter-key',
  'bad-hash',
  'combined-overflow',
] as const)('refuses invalid claim: %s', (kind) => {
  const v = f.request();
  if (kind === 'cycle-overflow') v.candidateKey = '1000000001';
  if (kind === 'token-overflow')
    v.minimumOutputTokenRaw = '18446744073709551616';
  if (kind === 'zero-output') v.minimumOutputTokenRaw = '0';
  if (kind === 'unknown-field') Object.assign(v, { signingAllowed: true });
  if (kind === 'wrong-counter-key') v.kind = 'ExactOut';
  if (kind === 'bad-hash') v.sourceSha256 = 'A'.repeat(64);
  if (kind === 'combined-overflow') {
    v.maximumInputLamports = AUTO_BUY_BUDGET_MAX.toString();
    v.maximumFeeAndRentLamports = '1';
  }
  expect(() => autoBuyBudgetClaim(v)).toThrow();
});
