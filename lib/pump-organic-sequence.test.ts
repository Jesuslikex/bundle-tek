import { expect, it } from 'vitest';
import {
  planPumpOrganicSequence,
  uniformDelay,
  type PumpOrganicSequenceInput,
} from './pump-organic-sequence';
import { projectPumpHolderSequence } from './pump-holder-pricing';
import { decodePumpInitialBuyState } from './pump-initial-buy-state';
import { initialBuyFeeFixture } from '../test/pump-initial-buy-simulation-fixture';

const wallets = Array.from({ length: 6 }, (_, n) => `wallet${n}`);
const input = (
  over: Partial<PumpOrganicSequenceInput> = {},
): PumpOrganicSequenceInput => ({
  mode: 'Organic',
  buys: wallets.map((address) => ({
    address,
    tokenAmountRaw: '10000000000000',
  })),
  delayMinMs: 2_000,
  delayMaxMs: 20_000,
  slippageBps: 500,
  quoteMint: 'So11111111111111111111111111111111111111112',
  curve: {
    virtualTokensRaw: '1073000000000000',
    virtualQuoteRaw: '30000000000',
    realTokensRaw: '793100000000000',
  },
  feeConfig: decodePumpInitialBuyState('FeeConfig', initialBuyFeeFixture()),
  ...over,
});
/** Deterministic counter source for reproducible delays. */
const counter = (values: number[]) => {
  let n = 0;
  return () => values[n++ % values.length];
};

it('draws unbiased uniform delays and rejects modulo-biased values', () => {
  expect(uniformDelay(5, 5, () => 0)).toBe(5);
  expect(uniformDelay(0, 9, () => 13)).toBe(3);
  // limit for span 10 is 4294967290; 4294967295 must be rejected then 7 used.
  expect(uniformDelay(0, 9, counter([0xffff_ffff, 7]))).toBe(7);
  expect(() => uniformDelay(0, 9, () => -1)).toThrow('unsigned');
  expect(() => uniformDelay(0, 9, () => 0xffff_ffff)).toThrow('unbiased');
});

it('plans an Organic schedule with sequential caps and lifetime-bounded batches', () => {
  const plan = planPumpOrganicSequence(input(), counter([0, 17_999, 9_000]));
  expect(plan.rows.map((r) => r.delayMs)).toEqual([
    0, 2_000, 19_999, 11_000, 2_000, 19_999,
  ]);
  for (const batch of plan.batches)
    expect(batch.spanMs).toBeLessThanOrEqual(plan.batchWindowMs);
  expect(plan.batches.flatMap((b) => b.indexes)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(plan.batches.length).toBeGreaterThan(1);
  const projection = projectPumpHolderSequence({
    quoteMint: input().quoteMint,
    curve: input().curve,
    feeConfig: input().feeConfig,
    trades: wallets.map((address) => ({
      address,
      kind: 'exact-base-output' as const,
      tokenAmountRaw: '10000000000000',
      maximumQuoteCostRaw: '18446744073709551615',
    })),
  });
  plan.rows.forEach((row, n) => {
    const projected = BigInt(projection.rows[n].projectedQuoteCostRaw);
    expect(row.projectedQuoteCostRaw).toBe(projected.toString());
    expect(BigInt(row.maximumQuoteCostRaw)).toBe(
      (projected * 10_500n + 9_999n) / 10_000n,
    );
  });
  // Later buys cost more on the curve: the plan must preserve order.
  expect(
    BigInt(plan.rows[5].projectedQuoteCostRaw) >
      BigInt(plan.rows[0].projectedQuoteCostRaw),
  ).toBe(true);
  expect(plan).toMatchObject({
    approvalRequiredPerBatch: true,
    simulationRequiredPerBuy: true,
    signingAllowed: false,
    executionAllowed: false,
  });
});

it('keeps a fixed Stagger delay and starts a new batch past the window', () => {
  const plan = planPumpOrganicSequence(
    input({ mode: 'Stagger', delayMinMs: 15_000, delayMaxMs: 15_000 }),
  );
  expect(plan.rows.map((r) => r.delayMs)).toEqual([
    0, 15_000, 15_000, 15_000, 15_000, 15_000,
  ]);
  expect(plan.batches.map((b) => b.indexes)).toEqual([
    [0, 1, 2, 3],
    [4, 5],
  ]);
  expect(plan.totalDurationMs).toBe(75_000);
});

it('gives each buy its own batch when the delay exceeds the window', () => {
  const plan = planPumpOrganicSequence(
    input({ mode: 'Stagger', delayMinMs: 60_000, delayMaxMs: 60_000 }),
  );
  expect(plan.batches).toHaveLength(6);
  expect(plan.batches.every((b) => b.spanMs === 0)).toBe(true);
});

it('rejects unsafe or ambiguous sequence options', () => {
  expect(() =>
    planPumpOrganicSequence(input({ delayMinMs: 20_000, delayMaxMs: 20_000 })),
  ).toThrow('Stagger');
  expect(() =>
    planPumpOrganicSequence(
      input({ mode: 'Stagger', delayMinMs: 1_000, delayMaxMs: 2_000 }),
    ),
  ).toThrow('fixed');
  expect(() => planPumpOrganicSequence(input({ delayMinMs: 100 }))).toThrow(
    'milliseconds',
  );
  expect(() =>
    planPumpOrganicSequence(input({ delayMinMs: 5_000, delayMaxMs: 4_000 })),
  ).toThrow('exceed');
  expect(() => planPumpOrganicSequence(input({ slippageBps: 5_001 }))).toThrow(
    'Slippage',
  );
  expect(() =>
    planPumpOrganicSequence(input({ batchWindowMs: 61_000 })),
  ).toThrow('blockhash');
  expect(() =>
    planPumpOrganicSequence(
      input({
        buys: [
          { address: 'a', tokenAmountRaw: '1' },
          { address: 'a', tokenAmountRaw: '1' },
        ],
      }),
    ),
  ).toThrow('once');
  expect(() => planPumpOrganicSequence(input({ buys: [] }))).toThrow(
    'none are dropped',
  );
  expect(() =>
    planPumpOrganicSequence({ ...input(), extra: 1 } as never),
  ).toThrow('Unsupported');
  expect(() =>
    planPumpOrganicSequence(
      input({ buys: [{ address: 'a', tokenAmountRaw: '793100000000000' }] }),
    ),
  ).toThrow('exhausts');
});
