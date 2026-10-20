import { describe, it, expect } from 'vitest';
import {
  buildWarmupPlan,
  drawWarmupAmounts,
  formatWarmupDelay,
  warmupBuyAmount,
  warmupDelaySeconds,
  WarmupPlanInputError,
} from './wallet-warmup';
const now = Date.parse('2026-10-10T00:00:00Z');
const wallets = [
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
];
const base = {
  chain: 'Solana',
  addresses: wallets,
  tokens: ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'],
  amount: '0.01',
  feeReserve: '0.005',
  cycles: 2,
  intervalSeconds: 30,
  startAt: '2026-10-10T01:00:00Z',
};
const field = (patch: object) => {
  try {
    buildWarmupPlan({ ...base, ...patch }, now);
  } catch (e) {
    expect(e).toBeInstanceOf(WarmupPlanInputError);
    return (e as WarmupPlanInputError).field;
  }
  throw new Error('accepted');
};
describe('warmup range amounts and second delays', () => {
  it('binds exact saved per-wallet, per-cycle range amounts and budgets', () => {
    const amounts = [
      ['0.01', '0.02'],
      ['0.015', '0.03'],
    ];
    const plan = buildWarmupPlan({ ...base, amountMax: '0.03', amounts }, now);
    expect(plan.buyAmountMax).toBe('0.03');
    expect(plan.buyAmounts).toEqual(amounts);
    expect(plan.walletBudgets).toEqual([
      { address: wallets[0], required: '0.035' },
      { address: wallets[1], required: '0.05' },
    ]);
    expect(plan.requiredPerWallet).toBe('0.05');
    expect(plan.totalBudget).toBe('0.085');
    const buys = plan.actions.filter((a) => a.side === 'Buy');
    expect(
      buys.find((a) => a.address === wallets[1] && a.cycle === 2)!.amount,
    ).toBe('0.03');
    const doc = { ...base, amountMax: '0.03', amounts };
    expect(warmupBuyAmount(doc, wallets[1], 1)).toBe('0.015');
    expect(warmupBuyAmount(base, wallets[1], 2)).toBe('0.01');
    expect(() => warmupBuyAmount(doc, 'other', 1)).toThrow();
  });
  it('rejects missing, misshaped or out-of-range amounts', () => {
    expect(field({ amountMax: '0.03' })).toBe('amountMax');
    expect(field({ amountMax: '0.01', amounts: [['0.01', '0.01']] })).toBe(
      'amountMax',
    );
    expect(field({ amountMax: '0.03', amounts: [['0.01', '0.02']] })).toBe(
      'amountMax',
    );
    expect(
      field({
        amountMax: '0.03',
        amounts: [
          ['0.01', '0.031'],
          ['0.01', '0.01'],
        ],
      }),
    ).toBe('amountMax');
    expect(field({ amounts: [['0.01'], ['0.01']] })).toBe('amountMax');
  });
  it('draws amounts inside the range on a micro grid', () => {
    const picks = [0n, 5n, 10000n, 3n];
    let i = 0;
    const drawn = drawWarmupAmounts('0.01', '0.02', 9, 2, 2, (bound) => {
      expect(bound).toBe(10001n);
      return picks[i++];
    });
    expect(drawn).toEqual([
      ['0.01', '0.010005'],
      ['0.02', '0.010003'],
    ]);
    const random = drawWarmupAmounts('0.1', '0.2', 9, 3, 5);
    expect(() =>
      buildWarmupPlan(
        {
          ...base,
          addresses: [...wallets, '11111111111111111111111111111111'],
          cycles: 5,
          amount: '0.1',
          amountMax: '0.2',
          amounts: random,
        },
        now,
      ),
    ).not.toThrow();
    expect(() => drawWarmupAmounts('0.2', '0.1', 9, 1, 1)).toThrow();
  });
  it('schedules second-level delays and keeps legacy minute plans', () => {
    const plan = buildWarmupPlan(base, now);
    expect(plan.intervalSeconds).toBe(30);
    expect(plan.intervalMinutes).toBeUndefined();
    const times = plan.actions.map((a) => a.scheduledAt);
    expect(times[0]).toBe('2026-10-10T01:00:00.000Z');
    expect(times.at(-1)).toBe('2026-10-10T01:00:48.750Z');
    expect(field({ intervalSeconds: 9 })).toBe('intervalSeconds');
    expect(field({ intervalSeconds: 30.5 })).toBe('intervalSeconds');
    const legacy = { ...base, intervalSeconds: undefined, intervalMinutes: 60 };
    expect(buildWarmupPlan(legacy, now).intervalSeconds).toBe(3600);
    expect(warmupDelaySeconds(legacy)).toBe(3600);
    expect(field({ intervalSeconds: undefined, intervalMinutes: 14 })).toBe(
      'intervalMinutes',
    );
    expect(formatWarmupDelay(3690)).toBe('1h 1m 30s');
  });
});
