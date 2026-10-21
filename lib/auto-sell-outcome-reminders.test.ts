import { expect, it, vi } from 'vitest';
import {
  AutoSellRunner,
  AUTO_SELL_OUTCOME_REMINDER_LIMIT,
} from './auto-sell-runner';
import { newAutoSellStrategy, type AutoSellObservedTrade } from './auto-sell';
import { autoSellOutcomeReference as ref } from '../test/auto-sell-outcome-fixture';
async function flush() {
  for (let n = 0; n < 12; n++) await Promise.resolve();
}
function setup() {
  let feed: AutoSellObservedTrade[] = [],
    serial = 0;
  const sell = vi.fn(async (amount: bigint) => ({
    soldRaw: amount,
    signature: ref.signature,
    wallet: ref.wallet,
    outcome: {
      ...ref,
      intentId: `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`,
    },
  }));
  const runner = new AutoSellRunner({
    strategies: [
      { ...newAutoSellStrategy(0), id: 'a', replicationPercent: '50' },
    ],
    decimals: 6,
    totalSupplyRaw: 1000000000000n,
    ownWallets: new Set(),
    sell,
    readTrades: async () => feed,
    onUpdate: () => {},
    now: () => 0,
    random: () => 0,
    setTimer: () => null,
    clearTimer: () => {},
  });
  return {
    runner,
    sell,
    buy: async (id: string) => {
      feed = [
        {
          id,
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
    },
  };
}
it('retains original immutable outcome metadata after more than 200 activity entries without changing accounting', async () => {
  const f = setup();
  try {
    f.runner.start();
    await flush();
    await f.buy('first');
    const original = f.runner.snapshot().outcomes![0];
    for (let n = 0; n < 130; n++) {
      f.runner.pause();
      expect(f.runner.resume()).toBe(true);
      await flush();
    }
    const snapshot = f.runner.snapshot();
    expect(snapshot.log.some((row) => row.outcome)).toBe(false);
    expect(snapshot.outcomes).toEqual([original]);
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(original.outcome)).toBe(true);
    snapshot.outcomes!.length = 0;
    expect(f.runner.snapshot().outcomes).toEqual([original]);
    expect(snapshot.accountedRaw).toBe(5000000n);
    expect(f.sell).toHaveBeenCalledOnce();
  } finally {
    f.runner.stop();
  }
});
it('bounds reminders independently of the log and announces overflow without changing sold or queued limits', async () => {
  const f = setup();
  try {
    f.runner.start();
    await flush();
    for (let n = 0; n <= AUTO_SELL_OUTCOME_REMINDER_LIMIT; n++)
      await f.buy(`buy-${n}`);
    const snapshot = f.runner.snapshot();
    expect(snapshot.outcomes).toHaveLength(100);
    expect(snapshot.outcomeOverflow).toBe(true);
    expect(
      snapshot.outcomes![0].outcome.intentId.endsWith('000000000002'),
    ).toBe(true);
    expect(
      snapshot.outcomes!.at(-1)!.outcome.intentId.endsWith('000000000101'),
    ).toBe(true);
    expect(snapshot.accountedRaw).toBe(505000000n);
    expect(snapshot.states.a.bufferedRaw).toBe(0n);
    expect(f.sell).toHaveBeenCalledTimes(101);
  } finally {
    f.runner.stop();
  }
});
