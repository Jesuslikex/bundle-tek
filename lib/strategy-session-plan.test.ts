import { expect, it } from 'vitest';
import {
  planStrategySession,
  requireStrategySessionPlan,
} from './strategy-session-plan';
import {
  strategyContext,
  strategyInput,
} from '../test/strategy-session-fixture';
it('keeps strategy ceilings separate from the shared budget and time stop', () => {
  const plan = planStrategySession(strategyInput(), strategyContext());
  expect(plan.summary).toMatchObject({
    inputDecimals: 9,
    inputUnit: 'SOL',
    maximumInputRaw: '30000000',
    totalStrategyMaximumRaw: '30000000',
    competingForBudget: false,
    endsAt: '2026-10-18T12:10:00.000Z',
  });
  expect(plan.summary.strategies[0]).toMatchObject({
    maximumInputRaw: '20000000',
    nominalInputRaw: '25000000',
    maximumTrades: 4,
    effectiveEndsAt: '2026-10-18T12:05:00.000Z',
  });
  expect(plan.summary.strategies[1]).toMatchObject({
    endsAt: '2026-10-18T12:15:00.000Z',
    effectiveEndsAt: '2026-10-18T12:10:00.000Z',
  });
  expect(requireStrategySessionPlan(plan)).toEqual(plan);
  expect(plan).toMatchObject({
    planningOnly: true,
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  });
});
it('a session deadline excludes cycles due at or after the deadline', () => {
  const input = strategyInput();
  input.durationSeconds = 120;
  expect(
    planStrategySession(input, strategyContext()).summary.strategies[0]
      .maximumTrades,
  ).toBe(2);
});
it.each(['DCA', 'Limit'] as const)(
  'loose %s ceilings do not imply budget competition',
  (kind) => {
    const input = strategyInput();
    input.strategies = input.strategies.filter((row) => row.kind === kind);
    input.strategies[0].maxAmount = '1';
    if (input.strategies[0].kind === 'DCA') input.strategies[0].cycles = 2;
    const plan = planStrategySession(input, strategyContext());
    expect(plan.summary.totalStrategyMaximumRaw).toBe('10000000');
    expect(plan.summary.competingForBudget).toBe(false);
  },
);
it('compares bounded finite inputs with the shared amount without allocating it', () => {
  const input = strategyInput();
  input.maxAmount = '0.02';
  expect(
    planStrategySession(input, strategyContext()).summary.competingForBudget,
  ).toBe(true);
  input.durationSeconds = 60;
  const plan = planStrategySession(input, strategyContext());
  expect(plan.summary.totalStrategyMaximumRaw).toBe('15000000');
  expect(plan.summary.competingForBudget).toBe(false);
});
it('keeps exact token-input units above Number precision', () => {
  const input = strategyInput();
  input.side = 'Sell';
  input.maxAmount = '18446744073709.551615';
  input.strategies[0].maxAmount = input.maxAmount;
  const p = planStrategySession(input, strategyContext());
  expect(p.summary.maximumInputRaw).toBe('18446744073709551615');
  expect(p.summary.inputUnit).toBe('USDC');
  expect(p.summary.inputDecimals).toBe(6);
});
it('detaches input and context from the retained plan', () => {
  const input = strategyInput(),
    context = strategyContext(),
    plan = planStrategySession(input, context);
  input.strategies[0].maxAmount = '1';
  context.token.symbol = 'OTHER';
  expect(plan.input.strategies[0].maxAmount).toBe('0.02');
  expect(plan.token.symbol).toBe('USDC');
});
it.each(['none', 'amount-only', 'time-only'] as const)(
  'preserves optional %s session and strategy stops',
  (kind) => {
    const input = strategyInput();
    input.maxAmount = kind === 'amount-only' ? '0.03' : null;
    input.durationSeconds = kind === 'time-only' ? 120 : null;
    input.strategies.forEach((row) => {
      row.maxAmount = null;
      row.durationSeconds = null;
    });
    const plan = planStrategySession(input, strategyContext());
    expect(plan.input.maxAmount).toBe(input.maxAmount);
    expect(plan.summary.endsAt).toBe(
      kind === 'time-only' ? '2026-10-18T12:02:00.000Z' : null,
    );
    expect(plan.summary.strategies[0].maximumTrades).toBe(
      kind === 'time-only' ? 2 : 5,
    );
    expect(requireStrategySessionPlan(plan)).toEqual(plan);
  },
);
it('the shared amount also bounds each strategy’s candidate upper bound', () => {
  const input = strategyInput();
  input.maxAmount = '0.01';
  expect(
    planStrategySession(input, strategyContext()).summary.strategies[0]
      .maximumTrades,
  ).toBe(2);
});
it.each(['archive', 'revision', 'network', 'missing'] as const)(
  'refuses a %s wallet',
  (change) => {
    const context = strategyContext();
    if (change === 'archive') context.wallets[0].archived = true;
    if (change === 'revision') context.wallets[0].revision++;
    if (change === 'network') context.wallets[0].chain = 'Base';
    if (change === 'missing') context.wallets.shift();
    expect(() => planStrategySession(strategyInput(), context)).toThrow(
      'wallets changed',
    );
  },
);
it.each(['zero', 'exponent', 'precision', 'overflow', 'negative'] as const)(
  'refuses %s amounts',
  (change) => {
    const input = strategyInput();
    input.maxAmount = {
      zero: '0',
      exponent: '1e3',
      precision: '0.0000000001',
      overflow: '18446744074',
      negative: '-1',
    }[change];
    expect(() => planStrategySession(input, strategyContext())).toThrow();
  },
);
it.each([
  'duplicate',
  'unknown',
  'too-many',
  'invalid-id',
  'bad-cycle',
  'bad-interval',
  'bad-direction',
  'cycle-over-cap',
  'limit-over-cap',
  'negative-duration',
  'noncanonical-date',
  'wrong-project',
  'wrong-revision',
] as const)('refuses %s terms', (change) => {
  const input = strategyInput();
  if (change === 'duplicate') input.strategies[1].id = input.strategies[0].id;
  if (change === 'unknown') Object.assign(input, { executionAllowed: true });
  if (change === 'too-many')
    input.strategies = Array(9).fill(input.strategies[0]);
  if (change === 'invalid-id') input.strategies[0].id = 'bad';
  if (change === 'bad-cycle' && input.strategies[0].kind === 'DCA')
    input.strategies[0].cycles = 1;
  if (change === 'bad-interval' && input.strategies[0].kind === 'DCA')
    input.strategies[0].intervalSeconds = 0;
  if (change === 'bad-direction')
    Object.assign(input.strategies[1], { direction: 'unknown' });
  if (change === 'cycle-over-cap' && input.strategies[0].kind === 'DCA')
    input.strategies[0].amountPerCycle = '0.1';
  if (change === 'limit-over-cap' && input.strategies[1].kind === 'Limit')
    input.strategies[1].amount = '1';
  if (change === 'negative-duration') input.strategies[0].durationSeconds = -1;
  if (change === 'noncanonical-date') input.startAt = '2026-10-18T12:00:00Z';
  if (change === 'wrong-project')
    input.projectId = '00000000-0000-4000-8000-000000000004';
  if (change === 'wrong-revision') input.projectRevision++;
  expect(() => planStrategySession(input, strategyContext())).toThrow();
});
it.each(['summary', 'authority', 'token', 'unknown'] as const)(
  'rebuild refuses altered %s in a saved plan',
  (change) => {
    const p = planStrategySession(strategyInput(), strategyContext());
    if (change === 'summary') p.summary.maximumInputRaw = '1';
    if (change === 'authority') Object.assign(p, { executionAllowed: true });
    if (change === 'token') Object.assign(p.token, { chain: 'Base' });
    if (change === 'unknown') Object.assign(p, { packet: 'private' });
    expect(() => requireStrategySessionPlan(p)).toThrow();
  },
);
