import { expect, it } from 'vitest';
import { readSavedWarmupDisplay } from './warmup-saved-plan-display';
import { warmupSavedDisplayFixture } from '../test/warmup-saved-plan-display-fixture';

it('reads expired archived configurations at their historical start, without changing budgets or revisions', () => {
  const plan = warmupSavedDisplayFixture();
  expect(readSavedWarmupDisplay({ plan }, plan.id)).toEqual(plan);
});

it.each([
  ['null', () => null],
  [
    'wrong plan',
    (p: ReturnType<typeof warmupSavedDisplayFixture>) => {
      p.id = 'different-plan';
    },
  ],
  [
    'missing tokens',
    (p: ReturnType<typeof warmupSavedDisplayFixture>) => {
      delete (p.document as Partial<typeof p.document>).tokens;
    },
  ],
  [
    'null wallet',
    (p: ReturnType<typeof warmupSavedDisplayFixture>) => {
      p.document.walletRevisions = [null!];
    },
  ],
  [
    'missing chain',
    (p: ReturnType<typeof warmupSavedDisplayFixture>) => {
      p.document.chain = '';
    },
  ],
  [
    'wrong budget',
    (p: ReturnType<typeof warmupSavedDisplayFixture>) => {
      p.document.totalBudget = '999';
    },
  ],
  [
    'missing captured wallet',
    (p: ReturnType<typeof warmupSavedDisplayFixture>) => {
      p.document.walletRevisions = [];
    },
  ],
  [
    'extra captured wallet',
    (p: ReturnType<typeof warmupSavedDisplayFixture>) => {
      p.document.walletRevisions.push(p.document.walletRevisions[0]);
    },
  ],
  [
    'bad date',
    (p: ReturnType<typeof warmupSavedDisplayFixture>) => {
      p.document.startAt = 'not a date';
    },
  ],
  [
    'oversized name',
    (p: ReturnType<typeof warmupSavedDisplayFixture>) => {
      p.document.name = 'a'.repeat(81);
    },
  ],
  [
    'noninteger cycle',
    (p: ReturnType<typeof warmupSavedDisplayFixture>) => {
      p.document.cycles = 1.5;
    },
  ],
] as const)(
  'refuses %s without publishing parser diagnostics',
  (_name, mutate) => {
    const plan = warmupSavedDisplayFixture();
    const mutated = mutate(plan);
    expect(() =>
      readSavedWarmupDisplay(
        { plan: mutated === null ? null : plan },
        warmupSavedDisplayFixture().id,
      ),
    ).toThrow(
      'Saved warmup details do not match this plan. Reload to try again.',
    );
  },
);

it('retains reviewed range amounts and the second-based delay', () => {
  const plan = warmupSavedDisplayFixture();
  delete plan.document.intervalMinutes;
  plan.document.intervalSeconds = 10;
  plan.document.amountMax = '0.003';
  plan.document.amounts = [['0.001', '0.003']];
  plan.document.totalBudget = '0.006';
  expect(readSavedWarmupDisplay({ plan }, plan.id)).toEqual(plan);
  plan.document.amounts[0][1] = '0.004';
  expect(() => readSavedWarmupDisplay({ plan }, plan.id)).toThrow(
    'Saved warmup details',
  );
});

it('supports EVM native units and legitimate budgets above the per-action decimal limit', () => {
  const plan = warmupSavedDisplayFixture();
  plan.document.chain = 'BNB';
  plan.document.addresses = ['0x' + '1'.repeat(40)];
  plan.document.tokens = ['0x' + '2'.repeat(40)];
  plan.document.walletRevisions[0].address = plan.document.addresses[0];
  plan.document.amount = '999999999999';
  plan.document.feeReserve = '1';
  plan.document.totalBudget = '1999999999999';
  expect(readSavedWarmupDisplay({ plan }, plan.id)).toEqual(plan);
});

it('keeps a historical network and delay below the current planning minimum readable without execution approval', () => {
  const plan = warmupSavedDisplayFixture();
  plan.document.chain = 'FormerNetwork';
  plan.document.intervalSeconds = 0;
  delete plan.document.intervalMinutes;
  expect(readSavedWarmupDisplay({ plan }, plan.id)).toEqual(plan);
});
