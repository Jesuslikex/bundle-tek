import { expect, it, vi } from 'vitest';
import { newAutoSellStrategy } from './auto-sell';
import { AutoSellRunner } from './auto-sell-runner';
import { AutoSellReviewRecoveryError } from './auto-sell-review-recovery';
import { autoSellReviewReference as ref } from '../test/auto-sell-review-fixture';
it.each([false, true])(
  'stops automatic work and retains unsigned recovery metadata even after Stop=%s',
  async (stopped) => {
    let now = 0,
      entered!: () => void,
      finish!: () => void,
      initial!: () => void,
      settle!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      initialPromise = new Promise<void>((resolve) => {
        initial = resolve;
      }),
      settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
    const sell = vi.fn(async () => {
      entered();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      throw new AutoSellReviewRecoveryError(ref);
    });
    const runner = new AutoSellRunner({
      strategies: [
        {
          ...newAutoSellStrategy(0),
          id: 'dca',
          mode: 'dca',
          amountUnit: 'tokens',
          dcaAmount: '5',
          dcaIntervalSeconds: 10,
        },
      ],
      decimals: 6,
      totalSupplyRaw: 1000000000000n,
      ownWallets: new Set(),
      readTrades: async () => {
        initial();
        return [];
      },
      sell,
      onUpdate: (s) => {
        if (s.reviewRecovery && !s.settling) settle();
      },
      now: () => now,
      random: () => 0,
      setTimer: () => null,
      clearTimer: () => {},
    });
    try {
      runner.start();
      await initialPromise;
      now = 10000;
      await runner.tick();
      await enteredPromise;
      if (stopped) runner.stop();
      finish();
      await settled;
      const view = runner.snapshot();
      expect(view.running).toBe(false);
      expect(view.reviewRecovery).toEqual(ref);
      expect(Object.isFrozen(view.reviewRecovery)).toBe(true);
      expect(view.accountedRaw).toBe(0n);
      expect(view.states.dca.soldRaw).toBe(0n);
      expect(view.states.dca.inFlightRaw).toBe(0n);
      expect(view.states.dca.bufferedRaw).toBe(stopped ? 0n : 5000000n);
      now = 50000;
      await runner.tick();
      expect(sell).toHaveBeenCalledOnce();
      expect(runner.resume()).toBe(false);
    } finally {
      runner.stop();
    }
  },
);
