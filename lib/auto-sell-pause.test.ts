import { expect, it, vi } from 'vitest';
import { AutoSellRunner, type AutoSellRunnerDeps } from './auto-sell-runner';
import { newAutoSellStrategy, type AutoSellObservedTrade } from './auto-sell';
import { AutoSellUncertainError } from './auto-sell-execute';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const buy = (id: string): AutoSellObservedTrade => ({
  id,
  sender: 'OUTSIDE',
  side: 'Buy',
  tokenAmount: '100',
  quoteAmount: '1',
  priceUsd: '1',
});
const flush = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
function fixture(options: Partial<AutoSellRunnerDeps> = {}) {
  let now = 0;
  let feed: AutoSellObservedTrade[] = [];
  let timerId = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const sell = vi.fn(async (amount: bigint, _signal: AbortSignal) => ({
    soldRaw: amount,
    signature: 'FIXTURE',
    wallet: 'FIXTURE',
  }));
  const readTrades = vi.fn(async (_signal: AbortSignal) => feed);
  const runner = new AutoSellRunner({
    strategies: [
      { ...newAutoSellStrategy(0), id: 'a', replicationPercent: '100' },
    ],
    decimals: 0,
    totalSupplyRaw: 1000n,
    ownWallets: new Set(),
    readTrades,
    sell,
    onUpdate: () => {},
    now: () => now,
    random: () => 0,
    setTimer: (fn, ms) => {
      timers.set(++timerId, { fn, ms });
      return timerId;
    },
    clearTimer: (id) => {
      timers.delete(id as number);
    },
    ...options,
  });
  return {
    runner,
    sell,
    readTrades,
    timers,
    feed: (value: AutoSellObservedTrade[]) => {
      feed = value;
    },
    time: (value: number) => {
      now = value;
    },
  };
}

it('pauses all new reads and rebases Counter history on resume', async () => {
  const t = fixture();
  t.runner.start();
  await flush();
  expect(t.runner.pause()).toBe(true);
  expect(t.runner.pause()).toBe(false);
  t.feed([buy('paused')]);
  await t.runner.tick();
  expect(t.readTrades).toHaveBeenCalledTimes(1);
  expect(t.runner.snapshot()).toMatchObject({
    running: true,
    paused: true,
    settling: false,
  });
  expect(t.runner.resume()).toBe(true);
  await flush();
  expect(t.sell).not.toHaveBeenCalled();
  t.feed([buy('new'), buy('paused')]);
  await t.runner.tick();
  await flush();
  expect(t.sell).toHaveBeenCalledTimes(1);
  expect(t.sell).toHaveBeenCalledWith(100n, expect.any(AbortSignal));
  expect(t.timers.size).toBe(1);
  t.runner.stop();
});

it('waits for an abort-ignoring old read and never applies its late result', async () => {
  const pending = deferred<AutoSellObservedTrade[]>();
  const read = vi
    .fn<AutoSellRunnerDeps['readTrades']>()
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue([]);
  const t = fixture({ readTrades: read });
  t.runner.start();
  t.runner.pause();
  expect(read.mock.calls[0][0].aborted).toBe(true);
  expect(t.runner.resume()).toBe(false);
  expect(t.runner.snapshot().settling).toBe(true);
  pending.resolve([buy('late')]);
  await flush();
  expect(t.runner.snapshot()).toMatchObject({
    paused: true,
    settling: false,
    marketCapUsd: null,
  });
  expect(t.runner.resume()).toBe(true);
  await flush();
  expect(t.sell).not.toHaveBeenCalled();
  expect(t.timers.size).toBe(1);
  t.runner.stop();
});

it('aborts an unsent sell and resumes its original buffered amount only after settlement', async () => {
  const pending = deferred<{
    soldRaw: bigint;
    signature: string;
    wallet: string;
  }>();
  const sell = vi
    .fn<AutoSellRunnerDeps['sell']>()
    .mockImplementationOnce(() => pending.promise)
    .mockImplementation(async (amount) => ({
      soldRaw: amount,
      signature: 'FIXTURE',
      wallet: 'FIXTURE',
    }));
  const t = fixture({ sell });
  t.runner.start();
  await flush();
  t.feed([buy('queued')]);
  await t.runner.tick();
  await flush();
  t.runner.pause();
  expect(sell.mock.calls[0][1].aborted).toBe(true);
  expect(t.runner.resume()).toBe(false);
  pending.reject(new Error('Aborted before signing.'));
  await flush();
  expect(t.runner.snapshot().states.a.bufferedRaw).toBe(100n);
  expect(t.runner.snapshot().states.a.soldRaw).toBe(0n);
  expect(t.runner.resume()).toBe(true);
  await flush();
  // Resume must not bypass the existing retry/backoff gate.
  expect(sell).toHaveBeenCalledTimes(1);
  t.time(15000);
  await t.runner.tick();
  await flush();
  expect(sell.mock.calls.map((call) => call[0])).toEqual([100n, 100n]);
  expect(t.runner.snapshot().states.a.soldRaw).toBe(100n);
  t.runner.stop();
});

it('retains a submitted outcome across pause and keeps the shared cap on resume', async () => {
  const pending = deferred<{
    soldRaw: bigint;
    signature: string;
    wallet: string;
  }>();
  const sell = vi
    .fn<AutoSellRunnerDeps['sell']>()
    .mockImplementationOnce(() => pending.promise)
    .mockImplementation(async (amount) => ({
      soldRaw: amount,
      signature: 'FIXTURE',
      wallet: 'FIXTURE',
    }));
  const t = fixture({
    sell,
    session: {
      startDelaySeconds: 0,
      endDurationSeconds: 0,
      endMaxSupplyPercent: '15',
    },
  });
  t.runner.start();
  await flush();
  t.feed([buy('sent')]);
  await t.runner.tick();
  await flush();
  t.runner.pause();
  pending.resolve({ soldRaw: 100n, signature: 'FIXTURE', wallet: 'FIXTURE' });
  await flush();
  expect(t.runner.snapshot()).toMatchObject({ paused: true, selling: false });
  expect(t.runner.snapshot().states.a.soldRaw).toBe(100n);
  expect(t.runner.resume()).toBe(true);
  await flush();
  expect(sell).toHaveBeenCalledTimes(1);
  t.feed([buy('next'), buy('sent')]);
  await t.runner.tick();
  await flush();
  expect(sell.mock.calls.map((call) => call[0])).toEqual([100n, 50n]);
  expect(t.runner.isRunning()).toBe(false);
});

it('counts an unknown submitted outcome and cannot resume beyond the cap', async () => {
  const pending = deferred<{
    soldRaw: bigint;
    signature: string;
    wallet: string;
  }>();
  const sell = vi.fn<AutoSellRunnerDeps['sell']>(() => pending.promise);
  const t = fixture({
    sell,
    session: {
      startDelaySeconds: 0,
      endDurationSeconds: 0,
      endMaxSupplyPercent: '10',
    },
  });
  t.runner.start();
  await flush();
  t.feed([buy('unknown')]);
  await t.runner.tick();
  await flush();
  t.runner.pause();
  pending.reject(
    new AutoSellUncertainError('Unknown outcome.', 'FIXTURE', 'FIXTURE'),
  );
  await flush();
  expect(t.runner.snapshot().states.a.soldRaw).toBe(100n);
  expect(t.runner.resume()).toBe(false);
  expect(sell).toHaveBeenCalledTimes(1);
});

it('does not stack missed DCA intervals during a long pause', async () => {
  const t = fixture({
    strategies: [
      {
        ...newAutoSellStrategy(0),
        id: 'a',
        mode: 'dca',
        dcaAmount: '10',
        dcaIntervalSeconds: 10,
      },
    ],
  });
  t.runner.start();
  await flush();
  expect(t.sell).toHaveBeenCalledTimes(1);
  t.runner.pause();
  t.time(300000);
  expect(t.runner.resume()).toBe(true);
  await flush();
  expect(t.sell).toHaveBeenCalledTimes(1);
  t.time(309999);
  await t.runner.tick();
  await flush();
  expect(t.sell).toHaveBeenCalledTimes(1);
  t.time(310000);
  await t.runner.tick();
  await flush();
  expect(t.sell).toHaveBeenCalledTimes(2);
  t.runner.stop();
});

it('keeps the whole-session deadline effective while paused', async () => {
  const t = fixture({
    session: {
      startDelaySeconds: 0,
      endDurationSeconds: 10,
      endMaxSupplyPercent: '',
    },
  });
  t.runner.start();
  await flush();
  t.runner.pause();
  t.time(10000);
  const deadline = [...t.timers.values()].find((timer) => timer.ms === 10000)!;
  deadline.fn();
  expect(t.runner.snapshot()).toMatchObject({ running: false, paused: false });
  expect(t.runner.resume()).toBe(false);
  expect(t.sell).not.toHaveBeenCalled();
  expect(t.timers.size).toBe(0);
});

it('checks individual strategy expiry while paused without reading trades', async () => {
  const t = fixture({
    strategies: [
      {
        ...newAutoSellStrategy(0),
        id: 'a',
        replicationPercent: '100',
        endDurationSeconds: 10,
      },
    ],
  });
  t.runner.start();
  await flush();
  t.runner.pause();
  t.time(10000);
  const check = [...t.timers.values()].find((timer) => timer.ms === 4000)!;
  check.fn();
  expect(t.runner.isRunning()).toBe(false);
  expect(t.runner.snapshot().states.a.status).toBe('ended');
  expect(t.readTrades).toHaveBeenCalledTimes(1);
  expect(t.runner.resume()).toBe(false);
});

it('Stop permanently ends a paused instance', async () => {
  const t = fixture();
  t.runner.start();
  await flush();
  expect(t.runner.resume()).toBe(false);
  t.runner.pause();
  t.runner.stop();
  expect(t.runner.snapshot()).toMatchObject({ running: false, paused: false });
  expect(t.runner.resume()).toBe(false);
  expect(t.runner.pause()).toBe(false);
  expect(t.timers.size).toBe(0);
});
