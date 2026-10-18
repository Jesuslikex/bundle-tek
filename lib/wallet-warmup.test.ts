import { describe, it, expect } from 'vitest';
import { buildWarmupPlan, WarmupPlanInputError } from './wallet-warmup';
import { WARMUP_HISTORY_LIMIT } from './warmup-history-capacity';
const now = Date.parse('2026-10-10T00:00:00Z');
const input = {
  chain: 'Base',
  addresses: [
    '0x1111111111111111111111111111111111111111',
    '0x2222222222222222222222222222222222222222',
  ],
  tokens: ['0x4200000000000000000000000000000000000006'],
  amount: '0.000000000000000001',
  feeReserve: '0.000000000000000002',
  cycles: 3,
  intervalMinutes: 60,
  startAt: '2026-10-10T01:00:00Z',
};
describe('warmup plans', () => {
  it.each([
    ['tokens', { tokens: [] }],
    ['tokens', { tokens: ['invalid'] }],
    ['tokens', { tokens: [input.addresses[0]] }],
    ['amount', { amount: '0' }],
    ['amount', { amount: '1e-3' }],
    ['feeReserve', { feeReserve: '0.0000000000000000001' }],
    ['cycles', { cycles: 0 }],
    ['intervalMinutes', { intervalMinutes: 14 }],
    ['startAt', { startAt: '2026-10-09T00:00:00Z' }],
  ])(
    'identifies the editable %s field without accepting invalid input',
    (field, patch) => {
      try {
        buildWarmupPlan({ ...input, ...patch }, now);
        expect.unreachable('Invalid plan was accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(WarmupPlanInputError);
        expect((error as WarmupPlanInputError).field).toBe(field);
      }
    },
  );
  it('retains capacity for five maximum-size buy-to-sell passes', () => {
    const addresses = Array.from(
      { length: 20 },
      (_, n) => '0x' + (n + 1).toString(16).padStart(40, '0'),
    );
    const plan = buildWarmupPlan({ ...input, addresses, cycles: 20 }, now);
    expect(plan.actions.filter((action) => action.side === 'Buy')).toHaveLength(
      400,
    );
    expect(
      plan.actions.filter((action) => action.side === 'Sell'),
    ).toHaveLength(400);
    expect(plan.actions.length * 5).toBe(WARMUP_HISTORY_LIMIT);
  });
  it('conserves exact budgets without assuming returned proceeds and orders pairs', () => {
    const p = buildWarmupPlan(input, now);
    expect(p.requiredPerWallet).toBe('0.000000000000000005');
    expect(p.totalBudget).toBe('0.00000000000000001');
    expect(p.actions).toHaveLength(12);
    expect(p.executionAllowed).toBe(false);
    for (const address of p.addresses)
      for (let cycle = 1; cycle <= 3; cycle++) {
        const pair = p.actions.filter(
          (a) => a.address === address && a.cycle === cycle,
        );
        expect(pair.map((a) => a.side)).toEqual(['Buy', 'Sell']);
        expect(
          Date.parse(pair[1].scheduledAt) - Date.parse(pair[0].scheduledAt),
        ).toBe(1800000);
      }
    expect(p.actions.map((a) => a.scheduledAt)).toEqual(
      p.actions.map((a) => a.scheduledAt).sort(),
    );
  });
  it('rejects duplicate/cross-purpose addresses and bounded workloads', () => {
    for (const patch of [
      { addresses: [input.addresses[0], input.addresses[0]] },
      { tokens: [input.addresses[0]] },
      { cycles: 0 },
      { cycles: 21 },
      { intervalMinutes: 14 },
      { addresses: Array(21).fill(input.addresses[0]) },
      { tokens: [] },
    ])
      expect(() => buildWarmupPlan({ ...input, ...patch }, now)).toThrow();
  });
  it('rejects precision loss, zero reserves, malformed decimals and stale start', () => {
    for (const patch of [
      { amount: '1e-9' },
      { amount: '0.0000000000000000001' },
      { feeReserve: '0' },
      { startAt: '2026-10-09T00:00:00Z' },
      { startAt: 'invalid' },
      { startAt: '2027-01-01T00:00:00Z' },
    ])
      expect(() => buildWarmupPlan({ ...input, ...patch }, now)).toThrow();
    expect(() =>
      buildWarmupPlan(
        {
          ...input,
          chain: 'Solana',
          addresses: ['11111111111111111111111111111111'],
          tokens: ['So11111111111111111111111111111111111111112'],
          amount: '0.0000000001',
        },
        now,
      ),
    ).toThrow('9 decimal');
  });
});
