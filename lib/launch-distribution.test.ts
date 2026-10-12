import { describe, expect, it } from 'vitest';
import { DEFAULT_LAUNCH_PLAN, validateLaunchPlan } from './launch-plan';
import {
  parseHolderDistribution,
  previewHolderDistribution,
  splitExactAtoms,
} from './launch-distribution';
const config = {
  kind: 'random' as const,
  deviationPercent: 50,
  seed: '1234567890abcdef1234567890abcdef',
};
const quotePlan = {
  ...DEFAULT_LAUNCH_PLAN,
  mode: 'Stagger' as const,
  holderCount: 3,
  holdersBuyQuote: '0.020000001',
  holdersDistribution: config,
};
const atoms = (text: string, decimals: number) => {
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole + fraction.padEnd(decimals, '0'));
};

describe('saved holder allocation distributions', () => {
  it('uses exact largest remainders without allocating to zero-weight slots', () => {
    expect(splitExactAtoms(10n, [1n, 1n, 1n])).toEqual([4n, 3n, 3n]);
    expect(splitExactAtoms(1n, [0n, 1n, 0n])).toEqual([0n, 1n, 0n]);
    expect(splitExactAtoms(0n, [1n, 1n])).toEqual([0n, 0n]);
    const total = 123456789012345678901234567890123456789012345678n;
    for (const count of [1, 2, 3, 7, 200]) {
      const weights = Array.from({ length: count }, (_, index) =>
        BigInt(index + 1),
      );
      const values = splitExactAtoms(total, weights);
      expect(values.reduce((sum, value) => sum + value, 0n)).toBe(total);
      expect(values.every((value) => value >= 0n)).toBe(true);
    }
    expect(() => splitExactAtoms(1n, [])).toThrow();
    expect(() => splitExactAtoms(1n, [0n])).toThrow();
    expect(() => splitExactAtoms(-1n, [1n])).toThrow();
  });
  it('retains the exact quote total and stable itemization after structural serialization', () => {
    const initial = previewHolderDistribution(quotePlan)!;
    const roundtrip = validateLaunchPlan(JSON.parse(JSON.stringify(quotePlan)));
    expect(previewHolderDistribution(roundtrip)).toEqual(initial);
    expect(initial.unit).toBe('SOL');
    expect(
      initial.items
        .map((item) => atoms(item.amount, 9))
        .reduce((sum, value) => sum + value, 0n),
    ).toBe(20000001n);
    expect(
      previewHolderDistribution({
        ...quotePlan,
        holdersDistribution: {
          ...config,
          seed: 'abcdef1234567890abcdef1234567890',
        },
      }),
    ).not.toEqual(initial);
    const equal = previewHolderDistribution({
      ...quotePlan,
      holdersBuyQuote: '0.000000002',
      holdersDistribution: { ...config, deviationPercent: 0 },
    })!;
    expect(equal.items.map((item) => item.amount)).toEqual([
      '0.000000001',
      '0.000000001',
      '0',
    ]);
  });
  it('supports supply percentages, equal splits, power-law weights and a one-slot distribution', () => {
    const supply = previewHolderDistribution({
      ...DEFAULT_LAUNCH_PLAN,
      holderCount: 3,
      holdersDistribution: { ...config, deviationPercent: 0 },
    })!;
    expect(supply.unit).toBe('%');
    expect(
      supply.items
        .map((item) => atoms(item.amount, supply.decimals))
        .reduce((sum, value) => sum + value, 0n),
    ).toBe(atoms('20', supply.decimals));
    for (const deviationPercent of [0, 50, 100, 150, 1000, 1000000]) {
      const preview = previewHolderDistribution({
        ...quotePlan,
        holderCount: 200,
        holdersDistribution: { ...config, deviationPercent },
      })!;
      expect(
        preview.items.reduce((sum, item) => sum + atoms(item.amount, 9), 0n),
      ).toBe(20000001n);
    }
    const single = previewHolderDistribution({
      ...quotePlan,
      holdersDistribution: { ...config, kind: 'single' },
    })!;
    expect(single.items.filter((item) => item.amount !== '0')).toHaveLength(1);
    expect(single.items.find((item) => item.amount !== '0')?.amount).toBe(
      quotePlan.holdersBuyQuote,
    );
    const tiny = previewHolderDistribution({
      ...DEFAULT_LAUNCH_PLAN,
      holdersBuy: 1e-20,
      holdersDistribution: config,
    })!;
    expect(tiny.total).toBe('0.00000000000000000001');
  });
  it('allows absent legacy settings and rejects malformed seeds, kinds, bounds and unsupported quote precision', () => {
    expect(previewHolderDistribution(DEFAULT_LAUNCH_PLAN)).toBeNull();
    expect(parseHolderDistribution(config)).toEqual(config);
    for (const value of [
      { ...config, seed: 'wrong' },
      { ...config, kind: 'invented' },
      { ...config, deviationPercent: Infinity },
      { ...config, deviationPercent: -1 },
      { ...config, deviationPercent: 1000001 },
      [],
      false,
    ])
      expect(() => parseHolderDistribution(value)).toThrow();
    expect(() =>
      previewHolderDistribution({ ...quotePlan, holderCount: 0 }),
    ).toThrow('1 to 200');
    expect(() =>
      previewHolderDistribution({ ...quotePlan, holdersBuyQuote: undefined }),
    ).toThrow('Enter');
    expect(() =>
      previewHolderDistribution({ ...quotePlan, currency: 'USDC' }),
    ).toThrow('precision');
  });
});

describe('retained custom holder weights', () => {
  const custom = {
    ...config,
    kind: 'custom' as const,
    weights: ['1', '3', '0'],
  };
  it('rescales exact decimal weights to the total without floating-point loss or zero-slot allocation', () => {
    const plan = {
      ...quotePlan,
      holdersDistribution: custom,
      holdersBuyQuote: '0.020000002',
    };
    expect(
      previewHolderDistribution(plan)!.items.map((row) => row.amount),
    ).toEqual(['0.005000001', '0.015000001', '0']);
    const doubled = { ...plan, holdersBuyQuote: '0.04' };
    expect(
      previewHolderDistribution(doubled)!.items.map((row) => row.amount),
    ).toEqual(['0.01', '0.03', '0']);
    const precise = {
      ...plan,
      holdersBuyQuote: '0.000000004',
      holdersDistribution: {
        ...custom,
        weights: ['0.000000000000000001', '0.000000000000000003', '0'],
      },
    };
    expect(
      previewHolderDistribution(precise)!.items.map((row) => row.amount),
    ).toEqual(['0.000000001', '0.000000003', '0']);
    expect(
      previewHolderDistribution({
        ...plan,
        mode: 'Block-0',
        holdersBuy: 20,
      })!.items.map((row) => row.amount),
    ).toEqual(['5', '15', '0']);
  });
  it('canonicalizes saved weights and preserves their order through a full plan JSON roundtrip', () => {
    const plan = validateLaunchPlan({
      ...quotePlan,
      holdersDistribution: { ...custom, weights: ['1.000', '3.50', '0.000'] },
    });
    expect(plan.holdersDistribution!.weights).toEqual(['1', '3.5', '0']);
    expect(
      previewHolderDistribution(
        validateLaunchPlan(JSON.parse(JSON.stringify(plan))),
      ),
    ).toEqual(previewHolderDistribution(plan));
    const old = parseHolderDistribution({ ...config, weights: ['ignored'] });
    expect(old).toEqual(config);
  });
  it('rejects malformed, empty, oversized, zero-only and mismatched lists without resizing', () => {
    for (const weights of [
      undefined,
      [],
      ['0', '0'],
      ['-1'],
      ['1e3'],
      [' 1'],
      [1],
      [''],
      Array.from({ length: 201 }, () => '1'),
      ['1.0000000000000000001'],
    ])
      expect(() => parseHolderDistribution({ ...custom, weights })).toThrow();
    expect(() =>
      validateLaunchPlan({
        ...quotePlan,
        holderCount: 2,
        holdersDistribution: custom,
      }),
    ).toThrow('match');
    expect(() =>
      previewHolderDistribution({
        ...quotePlan,
        holderCount: 2,
        holdersDistribution: custom,
      }),
    ).toThrow('match');
  });
});
