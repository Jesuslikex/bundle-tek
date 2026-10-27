import { describe, it, expect } from 'vitest';
import {
  buildWarmupPlan,
  drawWarmupOrganic,
  warmupOrganic,
  warmupOrganicTerms,
  WarmupPlanInputError,
  type WarmupOrganicTerms,
} from './wallet-warmup';

const now = Date.parse('2026-10-10T00:00:00Z');
const wallets = [
  '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
  '3yZe7d3483sRS3g2tRf8R7VQ1n1n1n1n1n1n1n1n1n1n',
];
const tokens = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'So11111111111111111111111111111111111111112',
];
const base = {
  chain: 'Solana',
  addresses: wallets,
  tokens,
  amount: '0.01',
  feeReserve: '0.01',
  cycles: 4,
  intervalSeconds: 3600,
  startAt: '2026-10-10T01:00:00Z',
};
const terms: WarmupOrganicTerms = {
  jitterPercent: 30,
  holdMinSeconds: 60,
  holdMaxSeconds: 600,
  skipPercent: 25,
  randomTokens: true,
};

/** Deterministic stand-in for cryptoBelow. */
function sequence(values: number[]) {
  let index = 0;
  return (bound: bigint) => {
    const value = values[index++ % values.length];
    return BigInt(value) % bound;
  };
}

describe('organic warmup schedules', () => {
  it('leaves a legacy plan byte-identical when organic mode is off', () => {
    const legacy = buildWarmupPlan(base, now);
    expect(legacy).not.toHaveProperty('organic');
    expect(legacy).not.toHaveProperty('organicTerms');
    expect(legacy.actions).toHaveLength(wallets.length * base.cycles * 2);
  });

  it('draws without a token list instead of failing on a zero bound', () => {
    const drawn = drawWarmupOrganic(terms, 2, 3, 0, 3600, sequence([1]));
    expect(drawn.tokenPicks).toEqual([0, 0, 0]);
  });

  it('draws a cadence, hold, token and skip grid inside every bound', () => {
    const drawn = drawWarmupOrganic(
      terms,
      wallets.length,
      base.cycles,
      tokens.length,
      base.intervalSeconds,
      sequence([0, 1, 2, 3, 4, 5, 6, 7]),
    );
    expect(drawn.offsets).toHaveLength(wallets.length);
    expect(drawn.offsets[0]).toHaveLength(base.cycles);
    for (const row of drawn.holds)
      for (const hold of row) {
        expect(hold).toBeGreaterThanOrEqual(terms.holdMinSeconds);
        expect(hold).toBeLessThanOrEqual(terms.holdMaxSeconds);
      }
    for (const row of drawn.offsets)
      for (const offset of row) {
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset).toBeLessThan(base.cycles * base.intervalSeconds);
      }
    for (const pick of drawn.tokenPicks) {
      expect(pick).toBeGreaterThanOrEqual(0);
      expect(pick).toBeLessThan(tokens.length);
    }
    // The first cycle of every wallet is always kept.
    for (const row of drawn.skips) expect(row[0]).toBe(false);
  });

  it('keeps each wallet in order and never opens a cycle before its previous sell', () => {
    const drawn = drawWarmupOrganic(
      terms,
      wallets.length,
      base.cycles,
      tokens.length,
      base.intervalSeconds,
      sequence([0, 5, 9, 3, 7, 1, 8, 2]),
    );
    for (let wallet = 0; wallet < wallets.length; wallet++) {
      let previous = -1;
      for (let cycle = 0; cycle < base.cycles; cycle++) {
        if (drawn.skips[wallet][cycle]) continue;
        expect(drawn.offsets[wallet][cycle]).toBeGreaterThan(previous);
        previous = drawn.offsets[wallet][cycle] + drawn.holds[wallet][cycle];
      }
    }
  });

  it('applies the reviewed draws to the plan and drops skipped cycles from the budget', () => {
    const organic = {
      offsets: [
        [10, 3700, 7300, 10900],
        [900, 4500, 8100, 11700],
        [1800, 5400, 9000, 12600],
      ],
      holds: [
        [120, 300, 240, 600],
        [90, 480, 120, 300],
        [600, 60, 300, 120],
      ],
      tokenPicks: [1, 0, 1, 0],
      skips: [
        [false, true, false, false],
        [false, false, false, true],
        [false, false, true, false],
      ],
    };
    const plan = buildWarmupPlan({ ...base, organicTerms: terms, organic }, now);
    const buys = plan.actions.filter((action) => action.side === 'Buy');
    expect(buys).toHaveLength(9);
    expect(plan.actions).toHaveLength(18);
    // Skipped cycles contribute nothing to the budget.
    expect(plan.buyBudgetPerWallet).toBe('0.03');
    expect(plan.requiredPerWallet).toBe('0.04');
    expect(plan.totalBudget).toBe('0.12');
    // Reviewed token picks are honoured per cycle.
    expect(buys[0].token).toBe(tokens[1]);
    // No two wallets buy on the same second.
    expect(new Set(buys.map((action) => action.scheduledAt)).size).toBe(9);
    // Every sell follows its own buy by exactly the reviewed hold.
    const first = plan.actions[0];
    const sell = plan.actions.find(
      (action) =>
        action.side === 'Sell' &&
        action.address === first.address &&
        action.cycle === first.cycle,
    )!;
    expect(Date.parse(sell.scheduledAt) - Date.parse(first.scheduledAt)).toBe(
      120_000,
    );
    expect(plan.organic).toEqual(organic);
    expect(plan.organicTerms).toEqual(terms);
    expect(plan.limitations).toContain('disguised, not independent');
  });

  it('rebuilds the same plan from the same draws', () => {
    const organic = drawWarmupOrganic(
      terms,
      wallets.length,
      base.cycles,
      tokens.length,
      base.intervalSeconds,
      sequence([3, 1, 4, 1, 5, 9, 2, 6]),
    );
    const once = buildWarmupPlan({ ...base, organicTerms: terms, organic }, now);
    const twice = buildWarmupPlan({ ...base, organicTerms: terms, organic }, now);
    expect(twice).toEqual(once);
  });

  it('rejects tampered, stale or partial organic draws', () => {
    const organic = {
      offsets: [
        [10, 3700, 7300, 10900],
        [900, 4500, 8100, 11700],
        [1800, 5400, 9000, 12600],
      ],
      holds: [
        [120, 300, 240, 600],
        [90, 480, 120, 300],
        [600, 60, 300, 120],
      ],
      tokenPicks: [0, 1, 0, 1],
      skips: [
        [false, false, false, false],
        [false, false, false, false],
        [false, false, false, false],
      ],
    };
    const shape = {
      wallets: wallets.length,
      cycles: base.cycles,
      tokens: tokens.length,
      intervalSeconds: base.intervalSeconds,
    };
    const outOfOrder = structuredClone(organic);
    outOfOrder.offsets[0][2] = 5;
    expect(() => warmupOrganic(outOfOrder, terms, shape)).toThrow(
      /stay in order/,
    );

    const shortHold = structuredClone(organic);
    shortHold.holds[0][0] = 5;
    expect(() => warmupOrganic(shortHold, terms, shape)).toThrow(/out of range/);

    const wrongShape = structuredClone(organic);
    wrongShape.offsets[1] = [1, 2];
    expect(() => warmupOrganic(wrongShape, terms, shape)).toThrow(
      /Review the plan again/,
    );

    const badPick = structuredClone(organic);
    badPick.tokenPicks[0] = 9;
    expect(() => warmupOrganic(badPick, terms, shape)).toThrow(/out of range/);

    const unknown = { ...structuredClone(organic), extra: 1 };
    expect(() => warmupOrganic(unknown, terms, shape)).toThrow(/unknown/);

    // Draws without settings, and settings without draws, are both stale.
    expect(() => warmupOrganic(organic, undefined, shape)).toThrow(
      /Choose organic settings/,
    );
    expect(() =>
      buildWarmupPlan({ ...base, organicTerms: terms }, now),
    ).toThrow(/draw an organic schedule/);
  });

  it('rejects out-of-range organic settings', () => {
    expect(() => warmupOrganicTerms({ ...terms, jitterPercent: 51 })).toThrow(
      /jitter/,
    );
    expect(() => warmupOrganicTerms({ ...terms, skipPercent: 41 })).toThrow(
      /skip/,
    );
    expect(() =>
      warmupOrganicTerms({ ...terms, holdMinSeconds: 10 }),
    ).toThrow(/shortest hold/);
    expect(() =>
      warmupOrganicTerms({ ...terms, holdMaxSeconds: 30 }),
    ).toThrow(/longest hold/);
    expect(() => warmupOrganicTerms({ ...terms, randomTokens: 'yes' })).toThrow(
      /random/,
    );
    expect(() => warmupOrganicTerms({ ...terms, extra: 1 })).toThrow(/unknown/);
  });

  it('reports a hold range that cannot fit inside the cycle delay', () => {
    expect(() =>
      drawWarmupOrganic(
        { ...terms, holdMaxSeconds: 7200 },
        wallets.length,
        base.cycles,
        tokens.length,
        base.intervalSeconds,
      ),
    ).toThrow(/fit inside the cycle delay/);
  });

  it('surfaces a bad organic draw as the organic field', () => {
    try {
      buildWarmupPlan(
        { ...base, organicTerms: terms, organic: { offsets: [], holds: [], tokenPicks: [], skips: [] } },
        now,
      );
      expect.unreachable('Invalid organic draw was accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(WarmupPlanInputError);
      expect((error as WarmupPlanInputError).field).toBe('organic');
    }
  });
});
