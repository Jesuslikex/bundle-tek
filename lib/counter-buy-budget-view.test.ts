import { expect, it } from 'vitest';
import { counterBudgetUiFixture } from '../test/counter-budget-ui-fixture';
import {
  admitCounterBudgetReview,
  admitCounterBudgetSaved,
  admitCounterBudgetPreview,
  parseCounterBudgetReminder,
  counterBudgetReminder,
  counterBudgetLamports,
  counterBudgetSol,
  isCounterBudgetPrewriteRefusal,
} from './counter-buy-budget-view';
const now = Date.parse('2026-10-23T12:00:00.000Z');
it('admits the exact separate totals and opaque review hash without inventing trading authority', () => {
  const f = counterBudgetUiFixture(now);
  expect(
    admitCounterBudgetReview({ review: f.review }, f.selection, f.plan, now),
  ).toEqual(f.review);
  expect(
    parseCounterBudgetReminder(counterBudgetReminder(f.review)).review,
  ).toEqual(f.review);
});
it.each([
  'approvalAllowed',
  'reservationCreated',
  'accountingCapacityReserved',
  'signingAllowed',
  'executionAllowed',
  'automaticExecutionAllowed',
  'sourceVerified',
  'instructionsVerified',
  'walletFundsReserved',
])('refuses elevated %s', (key) => {
  const f = counterBudgetUiFixture(now);
  expect(() =>
    admitCounterBudgetReview(
      { review: { ...f.review, [key]: true } },
      f.selection,
      f.plan,
      now,
    ),
  ).toThrow();
});
it.each([
  'wallet',
  'walletRevision',
  'decisionIdentity',
  'budgetId',
  'planRevision',
  'projectRevision',
  'maximumInputLamports',
  'maximumFeeAndRentLamports',
  'expiresAt',
])('binds exact reviewed %s', (key) => {
  const f = counterBudgetUiFixture(now),
    changed = structuredClone(f.selection) as unknown as Record<
      string,
      unknown
    >;
  changed[key] = typeof changed[key] === 'number' ? 42 : 'different';
  expect(() =>
    admitCounterBudgetReview(
      { review: f.review },
      changed as never,
      f.plan,
      now,
    ),
  ).toThrow();
});
it('refuses inconsistent wallet/strategy totals, wrong source shape, unknown fields and expired reviews', () => {
  const f = counterBudgetUiFixture(now);
  for (const mutate of [
    (r: typeof f.review) => {
      r.terms.wallets[0].maximumInputLamports = '1';
    },
    (r: typeof f.review) => {
      r.terms.strategies[0].id = r.selection.budgetId;
    },
    (r: typeof f.review) => {
      r.terms.strategies[0].sourceSha256 = 'wrong';
    },
    (r: typeof f.review) => {
      Object.assign(r, { extra: false });
    },
  ]) {
    const r = structuredClone(f.review);
    mutate(r);
    expect(() =>
      admitCounterBudgetReview({ review: r }, f.selection, f.plan, now),
    ).toThrow();
  }
  expect(() =>
    admitCounterBudgetReview(
      { review: f.review },
      f.selection,
      f.plan,
      Date.parse(f.selection.expiresAt),
    ),
  ).toThrow();
  expect(() =>
    admitCounterBudgetReview(
      { review: f.review },
      f.selection,
      { ...f.plan, state: 'paused' },
      now,
    ),
  ).toThrow();
});
it('admits historical expired saved records without renewing their original expiry', () => {
  const f = counterBudgetUiFixture(now);
  f.saved.currentContext = 'not-checked-history';
  expect(
    admitCounterBudgetSaved({ saved: f.saved }, f.review).budget.terms
      .expiresAt,
  ).toBe(f.selection.expiresAt);
  expect(
    parseCounterBudgetReminder(counterBudgetReminder(f.review)),
  ).toBeTruthy();
});
it('refuses changed saved ID, terms, arithmetic, timestamp chronology or authority', () => {
  const f = counterBudgetUiFixture(now);
  for (const mutate of [
    (s: typeof f.saved) => {
      s.originalId = f.plan.id;
    },
    (s: typeof f.saved) => {
      s.budget.terms.maximumInputLamports = '2';
    },
    (s: typeof f.saved) => {
      s.budget.remainingInputLamports = '1';
    },
    (s: typeof f.saved) => {
      s.budget.updatedAt = new Date(now - 1).toISOString();
    },
    (s: typeof f.saved) => {
      Object.assign(s.budget, { signingAllowed: true });
    },
  ]) {
    const s = structuredClone(f.saved);
    mutate(s);
    expect(() => admitCounterBudgetSaved({ saved: s }, f.review)).toThrow();
  }
});
it('admits only an exact current nonreservable budget preview', () => {
  const f = counterBudgetUiFixture(now);
  expect(
    admitCounterBudgetPreview(
      { preview: f.budgetPreview },
      f.plan,
      f.budgetRequest,
      f.saved,
      now,
    ),
  ).toEqual(f.budgetPreview);
  for (const mutate of [
    (p: typeof f.budgetPreview) => {
      p.budgetRevision++;
    },
    (p: typeof f.budgetPreview) => {
      p.remainingInputLamports = '1';
    },
    (p: typeof f.budgetPreview) => {
      p.networkFeeLamports = '5001';
    },
    (p: typeof f.budgetPreview) => {
      p.sourceTradeCount++;
    },
    (p: typeof f.budgetPreview) => {
      p.outputTargetRaw = '1';
    },
    (p: typeof f.budgetPreview) => {
      p.maximumQuoteInputRaw = '1006';
    },
    (p: typeof f.budgetPreview) => {
      Object.assign(p, { approvalAllowed: true });
    },
  ]) {
    const p = structuredClone(f.budgetPreview);
    mutate(p);
    expect(() =>
      admitCounterBudgetPreview(
        { preview: p },
        f.plan,
        f.budgetRequest,
        f.saved,
        now,
      ),
    ).toThrow();
  }
  expect(() =>
    admitCounterBudgetPreview(
      { preview: f.budgetPreview },
      f.plan,
      f.budgetRequest,
      f.saved,
      now + 30000,
    ),
  ).toThrow();
});
it('permits same-ID fresh review only for the exact structured prewrite refusal', () => {
  const f = counterBudgetUiFixture(now),
    refusal = {
      format: 'owned-counter-budget-save-refusal-v1',
      scope: 'current-request-only',
      priorSaveOutcomeVerified: false,
      originalId: f.selection.budgetId,
      reviewSha256: f.review.reviewSha256,
      writerAttempted: false,
      recoveryRequired: false,
      error: 'Changed context',
    };
  expect(isCounterBudgetPrewriteRefusal(refusal, f.review)).toBe(true);
  for (const changed of [
    { error: 'No' },
    { ...refusal, originalId: f.plan.id },
    { ...refusal, reviewSha256: 'd'.repeat(64) },
    { ...refusal, writerAttempted: true },
    { ...refusal, unknown: false },
  ])
    expect(isCounterBudgetPrewriteRefusal(changed, f.review)).toBe(false);
});
it('uses canonical exact SOL/lamport conversion at the safe integer boundary', () => {
  expect(counterBudgetLamports('9007199.254740991')).toBe('9007199254740991');
  expect(counterBudgetSol('9007199254740991')).toBe('9007199.254740991');
  expect(counterBudgetLamports('0.000000001')).toBe('1');
  for (const value of [
    '9007199.254740992',
    '01',
    '1e-9',
    '-1',
    '0.0000000001',
    ' 1',
    '1.',
  ])
    expect(() => counterBudgetLamports(value)).toThrow();
});
