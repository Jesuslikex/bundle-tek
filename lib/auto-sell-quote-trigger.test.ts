import { expect, it, vi } from 'vitest';
import { AutoSellRunner } from './auto-sell-runner';
import type { AutoSellObservedTrade } from './auto-sell';
import {
  applyAutoSellTrade,
  initialAutoSellState,
  newAutoSellStrategy,
} from './auto-sell';
import {
  AUTO_SELL_SOL_QUOTE,
  autoSellQuoteAtLeast,
} from './auto-sell-quote-trigger';

const strategy = {
  ...newAutoSellStrategy(0),
  replicationPercent: '50',
  trigger: { kind: 'min-sol' as const, amount: '0.5' },
};
const context = {
  decimals: 6,
  totalSupplyRaw: 1000000000n,
  ownWallets: new Set<string>(),
  marketCapUsd: 1,
  random: () => 0,
};
const trade = {
  id: 'synthetic',
  timestamp: new Date(0).toISOString(),
  sender: 'outside',
  side: 'Buy' as const,
  tokenAmount: '10',
  quoteAmount: '1000',
  priceUsd: '1',
};

it('explains a quote-unit refusal in session activity without invoking a sell', async () => {
  let trades: AutoSellObservedTrade[] = [];
  const sell = vi.fn(async (soldRaw: bigint) => ({
    soldRaw,
    signature: 'SYNTHETIC',
    wallet: 'SYNTHETIC',
  }));
  const runner = new AutoSellRunner({
    strategies: [strategy],
    decimals: 6,
    totalSupplyRaw: context.totalSupplyRaw,
    ownWallets: context.ownWallets,
    readTrades: async () => trades,
    sell,
    onUpdate: () => {},
    now: () => 0,
    setTimer: () => null,
    clearTimer: () => {},
  });
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  runner.start();
  await flush();
  trades = [
    { ...trade, quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  ];
  await runner.tick();
  await flush();
  expect(sell).not.toHaveBeenCalled();
  expect(
    runner
      .snapshot()
      .log.some((entry) => entry.text.includes('not quoted in verified SOL')),
  ).toBe(true);
  trades = [{ ...trade, id: 'next', quoteMint: AUTO_SELL_SOL_QUOTE }];
  await runner.tick();
  await flush();
  expect(sell).toHaveBeenCalledTimes(1);
  runner.stop();
});

it.each([
  undefined,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  '11111111111111111111111111111111',
])(
  'does not interpret quote units %s as SOL even above the numeric threshold',
  (quoteMint) => {
    const result = applyAutoSellTrade(
      strategy,
      initialAutoSellState(0),
      { ...trade, quoteMint },
      context,
    );
    expect(result.outcome).toBe('quote-unit-mismatch');
    expect(result.addedRaw).toBe(0n);
    expect(result.state.responses).toBe(0);
  },
);
it.each([
  ['0.499999999999999999999999999999', false],
  ['0.500000000000000000000000000000', true],
  ['0.500000000000000000000000000001', true],
  ['NaN', false],
  ['Infinity', false],
  ['-1', false],
  ['1e9', false],
  ['', false],
])('requires exact valid SOL quote amount %s', (quoteAmount, accepted) => {
  const result = applyAutoSellTrade(
    strategy,
    initialAutoSellState(0),
    { ...trade, quoteAmount, quoteMint: AUTO_SELL_SOL_QUOTE },
    context,
  );
  expect(result.outcome).toBe(accepted ? 'buffered' : 'below-trigger');
  expect(result.addedRaw).toBe(accepted ? 5000000n : 0n);
});
it('compares amounts beyond safe floating-point integers and differing decimal precision', () => {
  expect(
    autoSellQuoteAtLeast(
      '9007199254740992.999999999999999999',
      '9007199254740993',
    ),
  ).toBe(false);
  expect(autoSellQuoteAtLeast('000.500000', '0.5')).toBe(true);
  expect(autoSellQuoteAtLeast('1', '1.000000000000000001')).toBe(false);
  expect(autoSellQuoteAtLeast('1'.repeat(41), '1')).toBe(false);
});
it.each(['rate', 'min-token'] as const)(
  'preserves %s triggering on other verified quote assets',
  (kind) => {
    const result = applyAutoSellTrade(
      {
        ...strategy,
        trigger:
          kind === 'rate' ? { kind, percent: '100' } : { kind, amount: '1' },
      },
      initialAutoSellState(0),
      { ...trade, quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
      context,
    );
    expect(result.outcome).toBe('buffered');
  },
);
