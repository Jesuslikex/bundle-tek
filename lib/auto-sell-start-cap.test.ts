import { expect, it } from 'vitest';
import { newAutoSellStrategy } from './auto-sell';
import { autoSellStartCapError } from './auto-sell-start-cap';

const strategy = {
  ...newAutoSellStrategy(0),
  replicationPercent: '100',
  minSupplyPercentPerSell: '0.5',
};
const supply = 100000n; // 1,000 tokens with two decimals. Minimum: 5 tokens.

it('names the exact conflicting token maximum and minimum', () => {
  expect(
    autoSellStartCapError(
      { ...strategy, endMaxTokenAmount: '4.99' },
      supply,
      2,
      null,
    ),
  ).toBe(
    'Minimum sell is 5 tokens, but the strategy maximum is 4.99 tokens. Increase that maximum or lower the minimum before starting.',
  );
});
it('uses the same exact calculation for legacy percentage limits', () => {
  expect(
    autoSellStartCapError(
      { ...strategy, endMaxSupplyPercent: '0.4' },
      supply,
      2,
      null,
    ),
  ).toContain('strategy maximum is 4 tokens');
});
it('identifies a shared cap even when the own cap has room', () => {
  expect(
    autoSellStartCapError(
      { ...strategy, endMaxTokenAmount: '10' },
      supply,
      2,
      499n,
    ),
  ).toContain('session maximum is 4.99 tokens');
});
it.each([500n, 501n, null])(
  'admits the exact minimum boundary or unbounded room %s',
  (cap) => {
    expect(
      autoSellStartCapError(
        { ...strategy, endMaxTokenAmount: '5' },
        supply,
        2,
        cap,
      ),
    ).toBeNull();
  },
);
it.each(['dca', 'limit'] as const)(
  'does not apply the Counter minimum to %s',
  (mode) => {
    expect(
      autoSellStartCapError(
        { ...strategy, mode, endMaxTokenAmount: '0.01' },
        supply,
        2,
        1n,
      ),
    ).toBeNull();
  },
);
it('keeps invalid precision fail-closed rather than rounding the warning', () => {
  expect(() =>
    autoSellStartCapError(
      { ...strategy, endMaxTokenAmount: '4.999' },
      supply,
      2,
      null,
    ),
  ).toThrow(/precision/);
});
it('uses exact arithmetic above the JavaScript safe-number range', () => {
  const big = 9007199254740993123456789n;
  const warning = autoSellStartCapError(
    {
      ...strategy,
      minSupplyPercentPerSell: '100',
      endMaxTokenAmount: '9007199254740993.123456788',
    },
    big,
    9,
    null,
  );
  expect(warning).toContain(
    'Minimum sell is 9007199254740993.123456789 tokens',
  );
  expect(warning).toContain('maximum is 9007199254740993.123456788 tokens');
});
