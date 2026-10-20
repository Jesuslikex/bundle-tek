import { expect, it, vi } from 'vitest';
import { autoSellMarketObservation } from './auto-sell-market-observation';
import { AutoSellRunner } from './auto-sell-runner';
import { newAutoSellStrategy, type AutoSellObservedTrade } from './auto-sell';
const trade = (at: number, priceUsd = '1'): AutoSellObservedTrade => ({
  id: `event-${at}`,
  sender: 'OUTSIDE',
  side: 'Sell',
  tokenAmount: '1',
  quoteAmount: '1',
  priceUsd,
  timestamp: new Date(at).toISOString(),
});
it('keeps the source timestamp and accepts exactly the existing 60-second age boundary', () => {
  expect(autoSellMarketObservation([trade(0)], 60000)).toEqual({
    priceUsd: '1',
    at: 0,
  });
  expect(autoSellMarketObservation([trade(0)], 60001)).toBeNull();
  expect(autoSellMarketObservation([trade(5000)], 10000)).toEqual({
    priceUsd: '1',
    at: 5000,
  });
});
it.each([
  undefined,
  '',
  'invalid',
  '1970-01-01 00:00:00',
  '1970-01-01T00:00:00+00:00',
  '1970-01-01T00:00:00.001Z',
])('withholds missing, malformed or future evidence %s', (timestamp) => {
  expect(autoSellMarketObservation([{ ...trade(0), timestamp }], 0)).toBeNull();
});
it('selects the newest valid source timestamp rather than a stale positive price earlier in the array', () => {
  expect(
    autoSellMarketObservation(
      [trade(0, '99'), trade(65000, '2'), trade(60000, '3')],
      70000,
    ),
  ).toEqual({ priceUsd: '2', at: 65000 });
  expect(
    autoSellMarketObservation(
      [trade(0, 'Infinity'), trade(0, '-1'), trade(0, '0')],
      0,
    ),
  ).toBeNull();
});
const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
function fixture(mode: 'dca' | 'limit' = 'dca') {
  let now = 0,
    feed: AutoSellObservedTrade[] = [trade(0)];
  const sell = vi.fn(async (soldRaw: bigint) => ({
    soldRaw,
    signature: 'SYNTHETIC',
    wallet: 'SYNTHETIC',
  }));
  const runner = new AutoSellRunner({
    strategies: [
      {
        ...newAutoSellStrategy(0),
        id: 'a',
        mode,
        marketCapMinUsd: '1',
        dcaAmount: '10',
        dcaIntervalSeconds: 10,
        limitOrders: [{ id: 'row', amount: '10', marketCapUsd: '100' }],
      },
    ],
    decimals: 0,
    totalSupplyRaw: 1000n,
    ownWallets: new Set(),
    readTrades: async () => feed,
    sell,
    onUpdate: () => {},
    now: () => now,
    setTimer: () => null,
    clearTimer: () => {},
  });
  return {
    runner,
    sell,
    time: (value: number) => {
      now = value;
    },
    feed: (value: AutoSellObservedTrade[]) => {
      feed = value;
    },
  };
}
it('does not renew DCA market freshness by repeatedly reading the same successfully returned event', async () => {
  const t = fixture();
  t.runner.start();
  await flush();
  expect(t.sell).toHaveBeenCalledTimes(1);
  t.time(30000);
  await t.runner.tick();
  await flush();
  t.time(60000);
  await t.runner.tick();
  await flush();
  expect(t.sell).toHaveBeenCalledTimes(3);
  t.time(70000);
  await t.runner.tick();
  await flush();
  expect(t.runner.snapshot().marketCapUsd).toBeNull();
  expect(t.sell).toHaveBeenCalledTimes(3);
  t.feed([trade(70000)]);
  await t.runner.tick();
  await flush();
  expect(t.sell).toHaveBeenCalledTimes(4);
  t.runner.stop();
});
it('withholds a stale limit target at startup and permits it only with fresh source evidence', async () => {
  const t = fixture('limit');
  t.time(61000);
  t.runner.start();
  await flush();
  expect(t.sell).not.toHaveBeenCalled();
  expect(t.runner.snapshot().states.a.filledLimitIds).toEqual([]);
  t.feed([trade(61000)]);
  await t.runner.tick();
  await flush();
  expect(t.sell).toHaveBeenCalledTimes(1);
  expect(t.runner.snapshot().states.a.filledLimitIds).toEqual(['row']);
  t.runner.stop();
});
it('does not roll market evidence back to an older response, or keep it after a clock reversal', async () => {
  const t = fixture();
  t.time(20000);
  t.feed([trade(20000, '2')]);
  t.runner.start();
  await flush();
  expect(t.runner.snapshot().marketCapUsd).toBe(2000);
  t.time(30000);
  t.feed([trade(10000, '9')]);
  await t.runner.tick();
  await flush();
  expect(t.runner.snapshot().marketCapUsd).toBe(2000);
  t.time(19000);
  t.feed([]);
  await t.runner.tick();
  await flush();
  expect(t.runner.snapshot().marketCapUsd).toBeNull();
  t.runner.stop();
});
