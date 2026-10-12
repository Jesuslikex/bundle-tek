import { describe, expect, it } from 'vitest';
import { getTransferCheckedInstructionDataEncoder } from '@solana-program/token';
import {
  buildDistributionPlan,
  canonicalDistributionAmount,
  formatDistributionAmount,
  isSolanaAddress,
  sumDistributionAmounts,
  toBaseUnits,
} from './distribution-plan';

const SYSTEM = '11111111111111111111111111111111';
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

describe('distribution plan', () => {
  it('writes the exact reviewed amount into the SDK transfer instruction', () => {
    const encoder = getTransferCheckedInstructionDataEncoder();
    expect([
      ...encoder.encode({ amount: toBaseUnits('0.3', 9), decimals: 9 }),
    ]).toEqual([12, 0, 163, 225, 17, 0, 0, 0, 0, 9]);
    expect([
      ...encoder.encode({
        amount: toBaseUnits('9007199254740993', 0),
        decimals: 0,
      }),
    ]).toEqual([12, 1, 0, 0, 0, 0, 0, 32, 0, 0]);
    expect([
      ...encoder.encode({
        amount: toBaseUnits('18446744073.709551615', 9),
        decimals: 9,
      }),
    ]).toEqual([12, 255, 255, 255, 255, 255, 255, 255, 255, 9]);
  });
  it('validates Solana addresses', () => {
    expect(isSolanaAddress(SYSTEM)).toBe(true);
    expect(isSolanaAddress('not-a-wallet')).toBe(false);
  });

  it('merges duplicates and creates deterministic batches', () => {
    const plan = buildDistributionPlan({
      manifest: `${SYSTEM}, 10, treasury\n${WRAPPED_SOL}, 20, community\n${SYSTEM}, 5, duplicate`,
      tokenSupply: 100,
      reservePercent: 20,
      batchSize: 1,
    });
    expect(plan.recipients).toHaveLength(2);
    expect(plan.recipients[0].amount).toBe('15');
    expect(plan.batches).toHaveLength(2);
    expect(plan.totalAmount).toBe('35');
    expect(plan.warnings).toHaveLength(1);
  });

  it('rejects allocations above the distributable supply', () => {
    expect(() =>
      buildDistributionPlan({
        manifest: `${SYSTEM}, 81`,
        tokenSupply: 100,
        reservePercent: 20,
        batchSize: 8,
      }),
    ).toThrow('exceeds');
  });

  it('converts UI token amounts without losing base-unit precision', () => {
    expect(toBaseUnits(12.345, 3)).toBe(12_345n);
    expect(() => toBaseUnits(0.0001, 3)).toThrow('precision');
  });

  it('merges decimal duplicates and converts the exact result for the mint', () => {
    const plan = buildDistributionPlan({
      manifest: `${SYSTEM}, 0.1\n${SYSTEM}, 0.2\n${WRAPPED_SOL}, 0.000000001`,
      tokenSupply: '1',
      reservePercent: '0',
      batchSize: 1,
    });
    expect(plan.recipients[0].amount).toBe('0.3');
    expect(plan.totalAmount).toBe('0.300000001');
    expect(toBaseUnits(plan.recipients[0].amount, 9)).toBe(300_000_000n);
    expect(
      sumDistributionAmounts(
        plan.batches[1].map((recipient) => recipient.amount),
      ),
    ).toBe('0.000000001');
    expect(JSON.parse(JSON.stringify(plan)).recipients[0].amount).toBe('0.3');
  });

  it('retains every digit beyond Number precision through review and conversion', () => {
    const plan = buildDistributionPlan({
      manifest: `${SYSTEM}, 9007199254740993\n${WRAPPED_SOL}, 0.000000001`,
      tokenSupply: '9007199254740994',
      reservePercent: '0',
      batchSize: 2,
    });
    expect(plan.totalAmount).toBe('9007199254740993.000000001');
    expect(plan.distributableAmount).toBe('9007199254740994');
    expect(toBaseUnits(plan.recipients[0].amount, 0)).toBe(
      9_007_199_254_740_993n,
    );
    expect(formatDistributionAmount(plan.totalAmount)).toBe(
      '9,007,199,254,740,993.000000001',
    );
    expect(() => toBaseUnits(9_007_199_254_740_992, 0)).toThrow(
      'exact decimal string',
    );
  });

  it('enforces the exact reserve boundary without floating point tolerance', () => {
    const input = {
      manifest: `${SYSTEM}, 0.3`,
      tokenSupply: '1',
      reservePercent: '70',
      batchSize: 1,
    };
    expect(buildDistributionPlan(input).distributableAmount).toBe('0.3');
    expect(() =>
      buildDistributionPlan({ ...input, manifest: `${SYSTEM}, 0.300000001` }),
    ).toThrow('exceeds');
    const fractional = buildDistributionPlan({
      ...input,
      manifest: `${SYSTEM}, 0.099999999`,
      tokenSupply: '0.3',
      reservePercent: '66.666666667',
    });
    expect(fractional.distributableAmount).toBe('0.099999999999');
    expect(() =>
      buildDistributionPlan({
        ...input,
        manifest: `${SYSTEM}, 0.1`,
        tokenSupply: '0.3',
        reservePercent: '66.666666667',
      }),
    ).toThrow('exceeds');
  });

  it('accepts exact u64 transfer limits and rejects overflow or mint rounding', () => {
    expect(toBaseUnits('18446744073709551615', 0)).toBe((1n << 64n) - 1n);
    expect(toBaseUnits('18446744073.709551615', 9)).toBe((1n << 64n) - 1n);
    expect(() => toBaseUnits('18446744073.709551616', 9)).toThrow('u64');
    expect(() => toBaseUnits('18446744073709551616', 0)).toThrow('u64');
    expect(() => toBaseUnits('0.123456789', 6)).toThrow('precision');
    expect(toBaseUnits('1.000000000', 0)).toBe(1n);
    expect(toBaseUnits('0.29', 2)).toBe(29n);
    expect(toBaseUnits('0.000000001', 9)).toBe(1n);
  });

  it('rejects malformed amounts and invalid review-group inputs', () => {
    for (const amount of ['1e3', '-1', 'NaN', '1.0000000001', '0']) {
      expect(() =>
        buildDistributionPlan({
          manifest: `${SYSTEM}, ${amount}`,
          tokenSupply: '10000',
          reservePercent: '0',
          batchSize: 1,
        }),
      ).toThrow();
    }
    for (const batchSize of [NaN, Infinity, 0, -1, 1.5, 13]) {
      expect(() =>
        buildDistributionPlan({
          manifest: `${SYSTEM}, 1`,
          tokenSupply: '100',
          reservePercent: '0',
          batchSize,
        }),
      ).toThrow('review group');
    }
    expect(canonicalDistributionAmount('00012.340000000')).toBe('12.34');
    expect(() => canonicalDistributionAmount('1,000')).toThrow('plain decimal');
    expect(() => canonicalDistributionAmount(0.30000000000000004)).toThrow(
      'precision',
    );
  });
});
