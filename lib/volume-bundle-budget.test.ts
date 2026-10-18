import { expect, it } from 'vitest';
import { planVolumeBundles } from './volume-bundle-plan';
import {
  applyVolumeTipEvent as apply,
  volumeTipTotals as totals,
  type VolumeTipBudget,
} from './volume-bundle-budget';
const fresh = (): VolumeTipBudget => ({
  format: 'volume-tip-budget-v1',
  plan: planVolumeBundles(
    {
      targetVolumeLamports: '1000000000',
      buyLamports: '50000000',
      durationSeconds: 1800,
      delayMinMs: 1000,
      delayMaxMs: 1000,
      tipBudgetLamports: '1000003',
      wallets: ['11111111111111111111111111111111'],
    },
    '0123456789abcdef0123456789abcdef',
  ),
  entries: [],
});
it('holds the complete cap across submission, replay and uncertain outcomes', () => {
  const original = fresh();
  const b = apply(original, { kind: 'reserve', round: 0, attemptId: 'a' });
  expect(original.entries).toEqual([]);
  expect(totals(b)).toEqual({
    heldLamports: '100000',
    spentLamports: '0',
    availableLamports: '900003',
  });
  expect(apply(b, { kind: 'reserve', round: 0, attemptId: 'a' })).toEqual(b);
  const submitted = apply(b, { kind: 'submitted', attemptId: 'a' });
  expect(apply(submitted, { kind: 'submitted', attemptId: 'a' })).toEqual(
    submitted,
  );
  expect(totals(submitted)).toEqual(totals(b));
  expect(() => apply(submitted, { kind: 'cancel', attemptId: 'a' })).toThrow();
  expect(() =>
    apply(submitted, { kind: 'reserve', round: 0, attemptId: 'retry' }),
  ).toThrow();
});
it('only returns unspent allowance after final accounting and never repeats a finalized round', () => {
  const b = apply(
    apply(fresh(), { kind: 'reserve', round: 0, attemptId: 'a' }),
    { kind: 'submitted', attemptId: 'a' },
  );
  const done = apply(b, {
    kind: 'finalized',
    attemptId: 'a',
    chargedLamports: '90000',
  });
  expect(totals(done)).toEqual({
    heldLamports: '0',
    spentLamports: '90000',
    availableLamports: '910003',
  });
  expect(
    apply(done, {
      kind: 'finalized',
      attemptId: 'a',
      chargedLamports: '90000',
    }),
  ).toEqual(done);
  expect(() =>
    apply(done, { kind: 'finalized', attemptId: 'a', chargedLamports: '0' }),
  ).toThrow();
  expect(() =>
    apply(done, { kind: 'reserve', round: 0, attemptId: 'retry' }),
  ).toThrow();
  expect(() =>
    apply(b, { kind: 'finalized', attemptId: 'a', chargedLamports: '100001' }),
  ).toThrow();
});
it('allows a cancelled unsigned reservation to be replaced, never reusing its identity', () => {
  const b = apply(
    apply(fresh(), { kind: 'reserve', round: 0, attemptId: 'a' }),
    { kind: 'cancel', attemptId: 'a' },
  );
  expect(totals(b).availableLamports).toBe('1000003');
  expect(() =>
    apply(b, { kind: 'reserve', round: 0, attemptId: 'a' }),
  ).toThrow();
  expect(
    totals(apply(b, { kind: 'reserve', round: 0, attemptId: 'b' }))
      .heldLamports,
  ).toBe('100000');
});
it('caps the complete session and refuses changed caps, malformed entries and forged plans', () => {
  let b = fresh();
  for (let round = 0; round < 10; round++)
    b = apply(b, { kind: 'reserve', round, attemptId: `round-${round}` });
  expect(totals(b)).toEqual({
    heldLamports: '1000000',
    spentLamports: '0',
    availableLamports: '3',
  });
  expect(() =>
    apply(b, { kind: 'reserve', round: 10, attemptId: 'extra' }),
  ).toThrow();
  const changed = structuredClone(b);
  changed.entries[0].capLamports = '100001';
  expect(() => totals(changed)).toThrow();
  const forged = structuredClone(b);
  forged.plan.rounds[0].tipCapLamports = '100001';
  expect(() => totals(forged)).toThrow();
  const duplicate = structuredClone(b);
  duplicate.entries[1].attemptId = duplicate.entries[0].attemptId;
  expect(() => totals(duplicate)).toThrow();
  expect(() =>
    apply(fresh(), { kind: 'submitted', attemptId: 'missing' }),
  ).toThrow();
});
