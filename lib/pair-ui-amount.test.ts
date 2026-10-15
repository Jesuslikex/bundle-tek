import { expect, it } from 'vitest';
import { amountToUiAmountForScaledUiAmountMintWithoutSimulation } from '@solana-program/token-2022';
import {
  pairUiAtoms,
  pairUiAmount,
  pairUiBudget,
  pairMultiplierHex,
  pairMultiplier,
  activePairMultiplier,
  validPairAmountPolicy,
  pairAmountLifetimeMs,
  type PairAmountPolicy,
} from './pair-ui-amount';
const unix = '1792088641';
const scaled = (
  multiplier: number,
  next = multiplier,
  effective = '0',
): PairAmountPolicy => ({
  kind: 'scaled-ui-v1',
  multiplierHex: pairMultiplierHex(multiplier),
  nextMultiplierHex: pairMultiplierHex(next),
  effectiveTimestamp: effective,
});
it.each([
  [2, '1.25', 8, '62500000', '1.25'],
  [0.5, '1.25', 8, '250000000', '1.25'],
  [1, '0.00000001', 8, '1', '0.00000001'],
  [0.1, '1', 0, '9', '1'],
  [0.3, '3', 0, '10', '3'],
] as const)(
  'converts %s-scaled UI budget %s conservatively into exact raw units',
  (m, amount, decimals, raw, display) => {
    expect(pairUiAtoms(amount, decimals, scaled(m), unix).toString()).toBe(raw);
    expect(pairUiAmount(raw, decimals, scaled(m), unix)).toBe(display);
  },
);
it('preserves exact unscaled u64 limits and admits larger UI budgets when scaling permits them', () => {
  expect(
    pairUiAtoms('184467440737.09551615', 8, { kind: 'unscaled' }, unix),
  ).toBe((1n << 64n) - 1n);
  expect(() =>
    pairUiAtoms('184467440737.09551616', 8, { kind: 'unscaled' }, unix),
  ).toThrow('Solana limits');
  expect(pairUiBudget('184467440737.09551616', 8)).toBe(1n << 64n);
  expect(
    pairUiAtoms('184467440737.09551616', 8, scaled(2), unix),
  ).toBeLessThanOrEqual(1n << 63n);
});
it.each([0.1, 0.3, 0.5, 1, 2, 3.141592653589793])(
  'matches native SPL display rounding for multiplier %s',
  (m) => {
    for (const raw of [
      '0',
      '1',
      '10',
      '123456789',
      '9007199254740993',
      '18446744073709551615',
    ])
      for (const decimals of [0, 6, 8, 18])
        expect(pairUiAmount(raw, decimals, scaled(m), unix)).toBe(
          amountToUiAmountForScaledUiAmountMintWithoutSimulation(
            BigInt(raw),
            decimals,
            m,
          ),
        );
  },
);
it('chooses the multiplier at the exact chain-clock transition and bounds quote lifetime', () => {
  const policy = scaled(1, 2, '1792088651');
  expect(activePairMultiplier(policy, '1792088650')).toBe(1);
  expect(activePairMultiplier(policy, '1792088651')).toBe(2);
  expect(pairAmountLifetimeMs([policy], unix)).toBe(9000);
  expect(pairAmountLifetimeMs([policy], '1792088650')).toBe(0);
  expect(pairAmountLifetimeMs([policy], '1792088651')).toBe(30000);
  expect(pairAmountLifetimeMs([policy], unix, Number(unix) * 1000 + 5000)).toBe(
    4000,
  );
  expect(
    pairAmountLifetimeMs([policy], unix, Number(unix) * 1000 + 11000),
  ).toBe(0);
});
it.each([0, -1, Infinity, NaN])('rejects invalid scaled multiplier %s', (m) => {
  expect(() => pairMultiplierHex(m)).toThrow();
});
it('rejects noncanonical scales, timestamps, raw amounts and imprecise user budgets', () => {
  for (const hex of [
    '7ff0000000000000',
    '7ff8000000000000',
    '0000000000000000',
    '3FF0000000000000',
  ])
    expect(() => pairMultiplier(hex)).toThrow();
  for (const time of [
    '01',
    '-0',
    '9223372036854775808',
    '-9223372036854775809',
  ])
    expect(
      validPairAmountPolicy({ ...scaled(1), effectiveTimestamp: time }),
    ).toBe(false);
  for (const amount of ['0', '-1', '1e3', '0.000000001', 'NaN'])
    expect(() => pairUiAtoms(amount, 8, scaled(2), unix)).toThrow();
  expect(() => pairUiAtoms('1', 0, scaled(2), unix)).toThrow('no spendable');
  expect(() =>
    pairUiAmount('18446744073709551616', 8, scaled(1), unix),
  ).toThrow();
  expect(() => pairUiAmount('01', 8, scaled(1), unix)).toThrow();
});
