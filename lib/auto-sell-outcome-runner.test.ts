import { expect, it, vi } from 'vitest';
import { newAutoSellStrategy, type AutoSellObservedTrade } from './auto-sell';
import { AutoSellRunner } from './auto-sell-runner';
import { AutoSellUncertainError } from './auto-sell-execute';
import { autoSellOutcomeReference as ref } from '../test/auto-sell-outcome-fixture';
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
it.each(['submitted', 'unknown', 'invalid', 'legacy'] as const)(
  'retains only valid detached lookup metadata without changing accounting or retries: %s',
  async (kind) => {
    let feed: AutoSellObservedTrade[] = [],
      now = 0;
    const reference = { ...ref };
    if (kind === 'invalid') reference.inputRaw = '0';
    const sell = vi.fn(async (amount: bigint) => {
      if (kind === 'unknown')
        throw new AutoSellUncertainError(
          'Synthetic unknown',
          ref.signature,
          ref.wallet,
          reference,
        );
      return {
        soldRaw: amount,
        signature: ref.signature,
        wallet: ref.wallet,
        ...(kind === 'legacy' ? {} : { outcome: reference }),
      };
    });
    const runner = new AutoSellRunner({
      strategies: [
        { ...newAutoSellStrategy(0), id: 'a', replicationPercent: '50' },
      ],
      decimals: 6,
      totalSupplyRaw: 1000000000000n,
      ownWallets: new Set(),
      readTrades: async () => feed,
      sell,
      onUpdate: () => {},
      now: () => now,
      random: () => 0,
      setTimer: () => null,
      clearTimer: () => {},
    });
    try {
      runner.start();
      await flush();
      feed = [
        {
          id: 'synthetic-buy',
          sender: 'OUTSIDE',
          side: 'Buy',
          tokenAmount: '10',
          quoteAmount: '1',
          priceUsd: '1',
          timestamp: new Date(0).toISOString(),
        },
      ];
      await runner.tick();
      await flush();
      const result = runner.snapshot();
      expect(result.accountedRaw).toBe(5000000n);
      expect(result.states.a.bufferedRaw).toBe(0n);
      const log = result.log.find(
        (x) => x.kind === (kind === 'unknown' ? 'error' : 'sell'),
      )!;
      expect(log).toBeTruthy();
      if (kind === 'submitted' || kind === 'unknown') {
        expect(log.outcome).toEqual(ref);
        expect(Object.isFrozen(log.outcome)).toBe(true);
        reference.wallet = ref.mint;
        expect(log.outcome!.wallet).toBe(ref.wallet);
      } else expect(log.outcome).toBeUndefined();
      now = 20000;
      await runner.tick();
      await flush();
      expect(sell).toHaveBeenCalledTimes(1);
      expect(runner.snapshot().accountedRaw).toBe(5000000n);
    } finally {
      runner.stop();
    }
  },
);
