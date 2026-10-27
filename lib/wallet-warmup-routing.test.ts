import { describe, expect, it } from 'vitest';
import {
  buildWarmupPlan,
  estimateWarmupTotals,
  WarmupPlanInputError,
  warmupSuggestedReserve,
  type WarmupInput,
} from './wallet-warmup';

const now = Date.parse('2026-10-10T00:00:00Z');
const wallets = [
  '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
  '8phnoC6V8nwYnNUwobNBoWzWAmyP1nj9GyYZaMbU8z4',
];
const base: WarmupInput = {
  chain: 'Solana',
  addresses: wallets,
  tokens: ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  amount: '0.01',
  feeReserve: '0.005',
  cycles: 2,
  intervalSeconds: 30,
  startAt: '2026-10-10T01:00:00Z',
};

describe('warmup routing and scheduling', () => {
  it('defaults to no platform and a staggered schedule', () => {
    const plan = buildWarmupPlan(base, now);
    expect(plan.platform).toBe('none');
    expect(plan.schedule).toBe('staggered');
    expect(plan.limitations).not.toContain('Axiom');
  });

  it('records Axiom routing and says it is only a declared intent', () => {
    const plan = buildWarmupPlan({ ...base, platform: 'axiom' }, now);
    expect(plan.platform).toBe('axiom');
    expect(plan.limitations).toContain('Axiom routing is a declared intent');
  });

  it('rejects an unknown platform', () => {
    try {
      buildWarmupPlan({ ...base, platform: 'jupiter' as never }, now);
      throw new Error('accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(WarmupPlanInputError);
      expect((error as WarmupPlanInputError).field).toBe('platform');
    }
  });

  it('rejects an unknown schedule', () => {
    try {
      buildWarmupPlan({ ...base, schedule: 'parallel' as never }, now);
      throw new Error('accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(WarmupPlanInputError);
      expect((error as WarmupPlanInputError).field).toBe('schedule');
    }
  });

  it('runs one wallet at a time in sequential mode', () => {
    const staggered = buildWarmupPlan(base, now);
    const sequential = buildWarmupPlan({ ...base, schedule: 'sequential' }, now);
    const firstBuy = (plan: typeof staggered, wallet: number) =>
      plan.actions.find((a) => a.address === wallets[wallet] && a.side === 'Buy')!
        .scheduledAt;
    // Staggered overlaps: wallet 2 starts before wallet 1 finishes.
    expect(Date.parse(firstBuy(staggered, 1))).toBeLessThan(
      Date.parse(staggered.actions.at(-1)!.scheduledAt),
    );
    // Sequential: wallet 2 only starts after wallet 1's whole run.
    expect(firstBuy(sequential, 1)).toBe('2026-10-10T01:01:00.000Z');
    expect(Date.parse(firstBuy(sequential, 1))).toBeGreaterThan(
      Date.parse(
        sequential.actions.filter((a) => a.address === wallets[0]).at(-1)!.scheduledAt,
      ),
    );
  });

  it('widens the estimated window when wallets run sequentially', () => {
    expect(estimateWarmupTotals(2, 2, '0.01', '0.005', 30, 9)!.seconds).toBe(49);
    expect(
      estimateWarmupTotals(2, 2, '0.01', '0.005', 30, 9, 'sequential')!.seconds,
    ).toBe(120);
  });

  it('scales the suggested reserve with routing and cycles', () => {
    expect(warmupSuggestedReserve('none', 2, 9)).toBe('0.00013');
    expect(warmupSuggestedReserve('axiom', 2, 9)).toBe('0.00273');
    expect(warmupSuggestedReserve('axiom', 1, 6)).toBe('1.365');
  });
});
