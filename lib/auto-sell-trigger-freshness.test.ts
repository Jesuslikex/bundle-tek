import { expect, it, vi } from 'vitest';
import { AutoSellRunner } from './auto-sell-runner';
import { newAutoSellStrategy, type AutoSellObservedTrade } from './auto-sell';
import { autoSellCounterEventTime } from './auto-sell-counter-time';

const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
function fixture(start = 100000) {
  let now = start,
    feed: AutoSellObservedTrade[] = [];
  const sell = vi.fn(async (soldRaw: bigint) => ({
    soldRaw,
    signature: 'SYNTHETIC',
    wallet: 'SYNTHETIC',
  }));
  const runner = new AutoSellRunner({
    strategies: [
      { ...newAutoSellStrategy(0), id: 'counter', replicationPercent: '100' },
    ],
    decimals: 0,
    totalSupplyRaw: 10000n,
    ownWallets: new Set(),
    readTrades: async () => feed,
    sell,
    onUpdate: () => {},
    now: () => now,
    random: () => 0,
    setTimer: () => null,
    clearTimer: () => {},
  });
  return {
    runner,
    sell,
    time: (value: number) => {
      now = value;
    },
    async offer(timestamp: string | undefined, id = 'newly-indexed') {
      feed = [
        {
          id,
          sender: 'OUTSIDE',
          side: 'Buy',
          tokenAmount: '100',
          quoteAmount: '1',
          priceUsd: '1',
          timestamp,
        },
      ];
      await runner.tick();
      await flush();
    },
    async start() {
      runner.start();
      await flush();
    },
  };
}
it.each([
  ['before-run', new Date(99999).toISOString()],
  ['future', new Date(100001).toISOString()],
  ['missing', undefined],
  ['malformed', 'not-a-time'],
  ['non-UTC', '1970-01-01T00:01:40+00:00'],
] as const)(
  'does not turn a delayed %s trade into a new Counter sell',
  async (_kind, timestamp) => {
    const f = fixture();
    await f.start();
    await f.offer(timestamp);
    expect(f.sell).not.toHaveBeenCalled();
    expect(f.runner.snapshot().states.counter).toMatchObject({
      bufferedRaw: 0n,
      inFlightRaw: 0n,
      soldRaw: 0n,
      responses: 0,
    });
    f.runner.stop();
  },
);
it('refuses an unseen original trade older than sixty seconds even after run start', async () => {
  const f = fixture(0);
  await f.start();
  f.time(100000);
  await f.offer(new Date(39999).toISOString());
  expect(f.sell).not.toHaveBeenCalled();
  f.runner.stop();
});
it('does not admit a late-indexed trade that occurred while paused', async () => {
  const f = fixture();
  await f.start();
  f.runner.pause();
  f.time(110000);
  expect(f.runner.resume()).toBe(true);
  await flush();
  await f.offer(new Date(105000).toISOString());
  expect(f.sell).not.toHaveBeenCalled();
  f.runner.stop();
});
it('accepts the exact start and age boundary without replaying the same ID', async () => {
  const f = fixture(0);
  await f.start();
  f.time(60000);
  await f.offer(new Date(0).toISOString());
  expect(f.sell).toHaveBeenCalledTimes(1);
  await f.offer(new Date(60000).toISOString());
  expect(f.sell).toHaveBeenCalledTimes(1);
  f.runner.stop();
});
it('admits a new original event exactly at resume without reviving paused history', async () => {
  const f = fixture();
  await f.start();
  f.runner.pause();
  f.time(110000);
  expect(f.runner.resume()).toBe(true);
  await flush();
  await f.offer(new Date(109999).toISOString(), 'paused');
  expect(f.sell).not.toHaveBeenCalled();
  await f.offer(new Date(110000).toISOString(), 'after-resume');
  expect(f.sell).toHaveBeenCalledTimes(1);
  f.runner.stop();
});
it.each([
  ['2026-02-30T00:00:00Z', Date.parse('2026-03-02T00:00:00Z'), 0, null],
  ['1970-01-01T00:00:40Z', 100000, 40000, 40000],
  ['1970-01-01T00:00:40Z', 100001, 0, null],
  ['1970-01-01T00:00:40.1Z', 40100, 0, 40100],
  ['1970-01-01T00:00:40.12Z', 40120, 0, 40120],
  ['1970-01-01T00:00:40.123Z', 40123, 0, 40123],
  ['1970-01-01T00:00:40Z', 40000, 40001, null],
  ['1970-01-01T00:00:40Z', NaN, 0, null],
  ['1970-01-01T00:00:40Z', 40000, -1, null],
] as const)(
  'validates original UTC time %s at %s with floor %s',
  (timestamp, now, floor, expected) => {
    expect(autoSellCounterEventTime(timestamp, now, floor)).toBe(expected);
  },
);
