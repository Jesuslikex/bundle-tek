import { expect, it } from 'vitest';
import {
  strategyInput,
  strategyContext,
} from '../test/strategy-session-fixture';
import { planStrategySession } from './strategy-session-plan';
import {
  applyReviewCapacity,
  emptyReviewCapacity,
  reviewCapacityTotals,
  strategyReviewCandidate,
} from './strategy-review-capacity';
const at = '2026-10-18T12:00:00.000Z',
  id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const plan = () => planStrategySession(strategyInput(), strategyContext());
it('shares an exact input cap across DCA and Limit, not separate spendable copies', () => {
  const p = plan();
  let state = emptyReviewCapacity();
  for (let i = 0; i < 4; i++)
    state = applyReviewCapacity(
      p,
      state,
      {
        kind: 'hold',
        id: id(i),
        strategyId: p.input.strategies[0].id,
        candidate: i,
      },
      at,
    );
  state = applyReviewCapacity(
    p,
    state,
    {
      kind: 'hold',
      id: id(9),
      strategyId: p.input.strategies[1].id,
      candidate: 0,
    },
    at,
  );
  expect(reviewCapacityTotals(p, state)).toMatchObject({
    heldRaw: '30000000',
    remainingRaw: '0',
  });
  expect(() =>
    applyReviewCapacity(
      p,
      state,
      {
        kind: 'hold',
        id: id(10),
        strategyId: p.input.strategies[0].id,
        candidate: 4,
      },
      at,
    ),
  ).toThrow('strategy');
  expect(state).toMatchObject({
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  });
});
it('refuses shared oversubscription even when each strategy fits its own cap', () => {
  const input = strategyInput();
  input.maxAmount = '0.01';
  input.strategies.forEach((r) => (r.maxAmount = null));
  const p = planStrategySession(input, strategyContext());
  const s = applyReviewCapacity(
    p,
    emptyReviewCapacity(),
    {
      kind: 'hold',
      id: id(1),
      strategyId: p.input.strategies[1].id,
      candidate: 0,
    },
    at,
  );
  expect(() =>
    applyReviewCapacity(
      p,
      s,
      {
        kind: 'hold',
        id: id(2),
        strategyId: p.input.strategies[0].id,
        candidate: 0,
      },
      at,
    ),
  ).toThrow('shared input cap');
});
it('releases unused unsigned capacity once and never reactivates a retained request ID', () => {
  const p = plan(),
    event = {
      kind: 'hold' as const,
      id: id(1),
      strategyId: p.input.strategies[0].id,
      candidate: 0,
    };
  const s = applyReviewCapacity(p, emptyReviewCapacity(), event, at),
    released = applyReviewCapacity(p, s, { kind: 'release', id: id(1) }, at);
  expect(reviewCapacityTotals(p, released).heldRaw).toBe('0');
  expect(
    applyReviewCapacity(p, released, event, '2026-10-18T13:00:00.000Z'),
  ).toEqual(released);
  expect(
    applyReviewCapacity(p, released, { kind: 'release', id: id(1) }, at),
  ).toEqual(released);
  expect(
    applyReviewCapacity(p, released, { ...event, id: id(2) }, at).holds,
  ).toHaveLength(2);
  expect(s.holds[0].state).toBe('held');
});
it('prevents a second active claim for the same immutable candidate', () => {
  const p = plan(),
    event = {
      kind: 'hold' as const,
      id: id(1),
      strategyId: p.input.strategies[0].id,
      candidate: 0,
    },
    s = applyReviewCapacity(p, emptyReviewCapacity(), event, at);
  expect(applyReviewCapacity(p, s, event, at)).toEqual(s);
  expect(() =>
    applyReviewCapacity(p, s, { ...event, id: id(2) }, at),
  ).toThrow();
  expect(() =>
    applyReviewCapacity(p, s, { ...event, candidate: 1 }, at),
  ).toThrow();
});
it('enforces half-open deadlines while retaining expired holds for explicit release', () => {
  const p = plan();
  expect(
    strategyReviewCandidate(p, p.input.strategies[0].id, 4).notBefore,
  ).toBe('2026-10-18T12:04:00.000Z');
  const e = {
    kind: 'hold' as const,
    id: id(1),
    strategyId: p.input.strategies[0].id,
    candidate: 0,
  };
  expect(() =>
    applyReviewCapacity(
      p,
      emptyReviewCapacity(),
      e,
      '2026-10-18T12:05:00.000Z',
    ),
  ).toThrow('ended');
  const s = applyReviewCapacity(p, emptyReviewCapacity(), e, at);
  expect(
    applyReviewCapacity(
      p,
      s,
      { kind: 'release', id: id(1) },
      '2026-10-19T12:00:00.000Z',
    ).holds[0].state,
  ).toBe('released');
  const input = strategyInput();
  input.durationSeconds = 60;
  const short = planStrategySession(input, strategyContext());
  expect(() =>
    strategyReviewCandidate(short, short.input.strategies[0].id, 1),
  ).toThrow('outside');
});
it('supports absent caps and exact u64 token inputs without Number conversion', () => {
  const input = strategyInput();
  input.side = 'Sell';
  input.maxAmount = '18446744073709.551615';
  input.durationSeconds = null;
  input.strategies = [
    {
      ...input.strategies[1],
      kind: 'Limit',
      amount: input.maxAmount,
      marketCapUsd: '1',
      direction: 'at-or-above',
      maxAmount: null,
      durationSeconds: null,
    },
  ];
  const p = planStrategySession(input, strategyContext()),
    s = applyReviewCapacity(
      p,
      emptyReviewCapacity(),
      {
        kind: 'hold',
        id: id(1),
        strategyId: p.input.strategies[0].id,
        candidate: 0,
      },
      at,
    );
  expect(reviewCapacityTotals(p, s)).toMatchObject({
    heldRaw: '18446744073709551615',
    remainingRaw: '0',
    strategies: [{ remainingRaw: null }],
  });
  input.maxAmount = null;
  expect(
    reviewCapacityTotals(planStrategySession(input, strategyContext()), s)
      .remainingRaw,
  ).toBeNull();
});
it.each([
  'units',
  'authority',
  'unknown',
  'state',
  'duplicate',
  'clock',
] as const)('refuses corrupted %s retained state', (kind) => {
  const p = plan(),
    s = applyReviewCapacity(
      p,
      emptyReviewCapacity(),
      {
        kind: 'hold',
        id: id(1),
        strategyId: p.input.strategies[0].id,
        candidate: 0,
      },
      at,
    );
  if (kind === 'units') s.holds[0].unitsRaw = '1';
  if (kind === 'authority') Object.assign(s, { executionAllowed: true });
  if (kind === 'unknown') Object.assign(s, { approval: true });
  if (kind === 'state') Object.assign(s.holds[0], { state: 'attempted' });
  if (kind === 'duplicate') s.holds.push(structuredClone(s.holds[0]));
  if (kind === 'clock')
    Object.assign(s.holds[0], {
      state: 'released',
      releasedAt: '2026-10-17T00:00:00.000Z',
    });
  expect(() => reviewCapacityTotals(p, s)).toThrow();
});
