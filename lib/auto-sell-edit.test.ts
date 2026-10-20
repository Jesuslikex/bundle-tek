import { expect, it, vi } from 'vitest';
import { AutoSellRunner, type AutoSellRunnerDeps } from './auto-sell-runner';
import { newAutoSellStrategy, type AutoSellObservedTrade } from './auto-sell';
import { AutoSellUncertainError } from './auto-sell-execute';

const strategy = (id = 'a') => ({
  ...newAutoSellStrategy(0),
  id,
  name: id,
  replicationPercent: '100',
});
const buy = (id: string): AutoSellObservedTrade => ({
  id,
  side: 'Buy',
  sender: 'OUTSIDE',
  tokenAmount: '100',
  quoteAmount: '1',
  priceUsd: '1',
  timestamp: new Date(0).toISOString(),
});
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fixture(options: Partial<AutoSellRunnerDeps> = {}) {
  let now = 0;
  let feed: AutoSellObservedTrade[] = [];
  let serial = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const sell = vi.fn(async (amount: bigint, _signal: AbortSignal) => ({
    soldRaw: amount,
    signature: 'FIXTURE',
    wallet: 'FIXTURE',
  }));
  const initial = {
    strategies: [strategy()],
    decimals: 0,
    totalSupplyRaw: 1000n,
    ownWallets: new Set<string>(),
    session: {
      startDelaySeconds: 0,
      endDurationSeconds: 100,
      endMaxSupplyPercent: '50',
    },
    readTrades: async () => feed,
    sell,
    onUpdate: () => {},
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      timers.set(++serial, { fn, ms });
      return serial;
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number);
    },
    ...options,
  };
  const runner = new AutoSellRunner(initial);
  return {
    runner,
    initial,
    sell,
    timers,
    time: (n: number) => {
      now = n;
    },
    feed: (value: AutoSellObservedTrade[]) => {
      feed = value;
    },
    start: async () => {
      runner.start();
      await flush();
    },
    trade: async (id: string) => {
      feed = [buy(id), ...feed];
      await runner.tick();
      await flush();
    },
  };
}

it('requires a settled pause and an exact positive approval, applying a review once', async () => {
  const t = fixture();
  await t.start();
  const next = t.runner.configuration();
  next.strategies[0].replicationPercent = '20';
  expect(() => t.runner.reviewEdit(next)).toThrow('Pause');
  t.runner.pause();
  const review = t.runner.reviewEdit(next);
  expect(() => t.runner.applyEdit(review.reviewKey, false)).toThrow(
    'Review and approve',
  );
  expect(() => t.runner.applyEdit('different', true)).toThrow(
    'Review and approve',
  );
  expect(t.runner.snapshot().configurationRevision).toBe(1);
  t.runner.applyEdit(review.reviewKey, true);
  expect(t.runner.configuration().strategies[0].replicationPercent).toBe('20');
  expect(t.runner.snapshot()).toMatchObject({
    paused: true,
    configurationRevision: 2,
  });
  expect(() => t.runner.applyEdit(review.reviewKey, true)).toThrow(
    'Review and approve',
  );
  t.runner.stop();
});

it('owns initial, returned and reviewed nested configuration independently of caller mutation', async () => {
  const t = fixture();
  t.initial.strategies[0].replicationPercent = '900';
  expect(t.runner.configuration().strategies[0].replicationPercent).toBe('100');
  await t.start();
  t.runner.pause();
  const next = t.runner.configuration();
  next.strategies[0].replicationPercent = '25';
  const review = t.runner.reviewEdit(next);
  next.strategies[0].replicationPercent = '700';
  review.after.strategies[0].replicationPercent = '800';
  t.runner.applyEdit(review.reviewKey, true);
  expect(t.runner.configuration().strategies[0].replicationPercent).toBe('25');
  t.runner.stop();
});

it('keeps removed strategy spending charged against the shared cap', async () => {
  const t = fixture();
  await t.start();
  await t.trade('before');
  t.runner.pause();
  const next = t.runner.configuration();
  next.strategies = [strategy('b')];
  next.session.endMaxSupplyPercent = '15';
  const review = t.runner.reviewEdit(next);
  expect(review.accountedRaw).toBe('100');
  t.runner.applyEdit(review.reviewKey, true);
  expect(t.runner.snapshot().accountedRaw).toBe(100n);
  expect(t.runner.snapshot().states.a).toBeUndefined();
  t.runner.resume();
  await flush();
  await t.trade('after');
  expect(t.sell.mock.calls.map((call) => call[0])).toEqual([100n, 50n]);
  expect(t.runner.snapshot().accountedRaw).toBe(150n);
  expect(t.runner.isRunning()).toBe(false);
});

it('does not reuse a removed strategy identifier to reset its history', async () => {
  const t = fixture();
  await t.start();
  await t.trade('before');
  t.runner.pause();
  const next = t.runner.configuration();
  next.strategies = [strategy('b')];
  t.runner.applyEdit(t.runner.reviewEdit(next).reviewKey, true);
  const reuse = t.runner.configuration();
  reuse.strategies.push(strategy('a'));
  expect(() => t.runner.reviewEdit(reuse)).toThrow('cannot be rearmed');
  expect(t.runner.snapshot().accountedRaw).toBe(100n);
  t.runner.stop();
});

it('preserves the original elapsed clock when unrelated settings are edited', async () => {
  const t = fixture({
    session: {
      startDelaySeconds: 0,
      endDurationSeconds: 10,
      endMaxSupplyPercent: '',
    },
  });
  await t.start();
  t.runner.pause();
  t.time(6000);
  const next = t.runner.configuration();
  next.strategies[0].replicationPercent = '30';
  t.runner.applyEdit(t.runner.reviewEdit(next).reviewKey, true);
  expect(t.runner.snapshot().states.a.startedAt).toBe(0);
  expect([...t.timers.values()].some((timer) => timer.ms === 4000)).toBe(true);
  t.time(10000);
  expect(t.runner.resume()).toBe(false);
  expect(t.runner.isRunning()).toBe(false);
});

it('anchors an explicitly extended duration to the original start instead of the edit time', async () => {
  const t = fixture({
    session: {
      startDelaySeconds: 0,
      endDurationSeconds: 10,
      endMaxSupplyPercent: '',
    },
  });
  await t.start();
  t.runner.pause();
  t.time(6000);
  const next = t.runner.configuration();
  next.session.endDurationSeconds = 20;
  t.runner.applyEdit(t.runner.reviewEdit(next).reviewKey, true);
  expect([...t.timers.values()].some((timer) => timer.ms === 14000)).toBe(true);
  t.time(20000);
  expect(t.runner.resume()).toBe(false);
});

it('ends immediately if a reviewed lower shared cap is already consumed', async () => {
  const t = fixture();
  await t.start();
  await t.trade('before');
  t.runner.pause();
  const next = t.runner.configuration();
  next.session.endMaxSupplyPercent = '5';
  const review = t.runner.reviewEdit(next);
  expect(review.endsSession).toBe(true);
  t.runner.applyEdit(review.reviewKey, true);
  expect(t.runner.isRunning()).toBe(false);
  expect(t.runner.snapshot().accountedRaw).toBe(100n);
  expect(t.sell).toHaveBeenCalledTimes(1);
});

it('clips an existing queued amount to a newly reduced per-strategy cap', async () => {
  const t = fixture({
    strategies: [{ ...strategy(), minSupplyPercentPerSell: '20' }],
  });
  await t.start();
  await t.trade('queued');
  expect(t.sell).not.toHaveBeenCalled();
  t.runner.pause();
  const next = t.runner.configuration();
  next.strategies[0].endMaxSupplyPercent = '5';
  next.strategies[0].minSupplyPercentPerSell = '';
  t.runner.applyEdit(t.runner.reviewEdit(next).reviewKey, true);
  t.runner.resume();
  await flush();
  expect(t.sell.mock.calls.map((call) => call[0])).toEqual([50n]);
  expect(t.runner.snapshot().states.a.soldRaw).toBe(50n);
  expect(t.runner.isRunning()).toBe(false);
});

it('rejects duplicate identities, invalid settings and resetting the start delay atomically', async () => {
  const t = fixture();
  await t.start();
  t.runner.pause();
  const first = t.runner.configuration();
  first.strategies[0].replicationPercent = '20';
  const prior = t.runner.reviewEdit(first);
  for (const mutate of [
    (next: ReturnType<AutoSellRunner['configuration']>) => {
      next.strategies.push(structuredClone(next.strategies[0]));
    },
    (next: ReturnType<AutoSellRunner['configuration']>) => {
      next.strategies[0].replicationPercent = '';
    },
    (next: ReturnType<AutoSellRunner['configuration']>) => {
      next.session.startDelaySeconds = 10;
    },
  ]) {
    const next = t.runner.configuration();
    mutate(next);
    expect(() => t.runner.reviewEdit(next)).toThrow();
    expect(t.runner.snapshot().configurationRevision).toBe(1);
  }
  expect(() => t.runner.applyEdit(prior.reviewKey, true)).toThrow(
    'Review and approve',
  );
  t.runner.stop();
});

it('invalidates a review when a strategy expires before approval', async () => {
  const t = fixture({
    strategies: [{ ...strategy(), endDurationSeconds: 5 }, strategy('b')],
  });
  await t.start();
  t.runner.pause();
  const next = t.runner.configuration();
  next.strategies[1].replicationPercent = '20';
  const review = t.runner.reviewEdit(next);
  t.time(6000);
  expect(() => t.runner.applyEdit(review.reviewKey, true)).toThrow(
    'Review and approve',
  );
  expect(t.runner.snapshot().states.a.status).toBe('ended');
  expect(t.runner.snapshot().configurationRevision).toBe(1);
  t.runner.stop();
});

it('keeps completed limit IDs while explicitly reviewing reactivation for a new order', async () => {
  const limit = {
    ...strategy(),
    mode: 'limit' as const,
    limitOrders: [{ id: 'old', amount: '10', marketCapUsd: '100' }],
  };
  const t = fixture({ strategies: [limit, strategy('b')] });
  t.feed([buy('history')]);
  await t.start();
  t.runner.pause();
  expect(t.runner.snapshot().states.a.status).toBe('ended');
  const next = t.runner.configuration();
  next.strategies[0].limitOrders.push({
    id: 'new',
    amount: '10',
    marketCapUsd: '200',
  });
  const review = t.runner.reviewEdit(next);
  expect(review.reactivatedStrategies).toEqual(['a']);
  t.runner.applyEdit(review.reviewKey, true);
  t.runner.resume();
  await flush();
  expect(t.sell.mock.calls.map((call) => call[0])).toEqual([100n, 100n]);
  expect(t.runner.snapshot().states.a.filledLimitIds).toEqual(['old', 'new']);
  expect(t.runner.snapshot().states.a.startedAt).toBe(0);
  t.runner.stop();
});

it('does not rearm completed limit IDs if only their amount or target changes', async () => {
  const limit = {
    ...strategy(),
    mode: 'limit' as const,
    limitOrders: [{ id: 'old', amount: '10', marketCapUsd: '100' }],
  };
  const t = fixture({ strategies: [limit, strategy('b')] });
  t.feed([buy('history')]);
  await t.start();
  t.runner.pause();
  const next = t.runner.configuration();
  next.strategies[0].limitOrders[0].amount = '20';
  const review = t.runner.reviewEdit(next);
  expect(review.reactivatedStrategies).toEqual([]);
  t.runner.applyEdit(review.reviewKey, true);
  t.runner.resume();
  await flush();
  expect(t.sell).toHaveBeenCalledTimes(1);
  t.runner.stop();
});

it('refuses mode/order rewrites with queued limit trades, and removal explicitly cancels the queue', async () => {
  const limit = {
    ...strategy(),
    mode: 'limit' as const,
    limitOrders: [{ id: 'old', amount: '10', marketCapUsd: '100' }],
  };
  const sell = vi
    .fn<AutoSellRunnerDeps['sell']>()
    .mockRejectedValue(new Error('Unsent.'));
  const t = fixture({ strategies: [limit, strategy('b')], sell });
  t.feed([buy('history')]);
  await t.start();
  t.runner.pause();
  const next = t.runner.configuration();
  next.strategies[0].limitOrders[0].amount = '20';
  expect(() => t.runner.reviewEdit(next)).toThrow('queued trades');
  next.strategies = next.strategies.filter((item) => item.id !== 'a');
  const review = t.runner.reviewEdit(next);
  expect(review.cancelledQueuedRaw).toBe('100');
  t.runner.applyEdit(review.reviewKey, true);
  expect(t.runner.snapshot().states.a).toBeUndefined();
  t.runner.stop();
});

it('cannot review during an unsettled sell or erase an uncertain amount by removing its strategy', async () => {
  let reject!: (reason: unknown) => void;
  const sell = vi.fn<AutoSellRunnerDeps['sell']>(
    () =>
      new Promise((_yes, no) => {
        reject = no;
      }),
  );
  const t = fixture({ sell });
  await t.start();
  t.feed([buy('pending')]);
  await t.runner.tick();
  t.runner.pause();
  expect(() => t.runner.reviewEdit(t.runner.configuration())).toThrow(
    'pending operation',
  );
  reject(new AutoSellUncertainError('Unknown.', 'FIXTURE', 'FIXTURE'));
  await flush();
  const next = t.runner.configuration();
  next.strategies = [strategy('b')];
  const review = t.runner.reviewEdit(next);
  expect(review.accountedRaw).toBe('100');
  t.runner.applyEdit(review.reviewKey, true);
  expect(t.runner.snapshot().accountedRaw).toBe(100n);
  t.runner.stop();
});

it('cancel and resume both invalidate retained edit approval', async () => {
  const t = fixture();
  await t.start();
  t.runner.pause();
  const draft = t.runner.configuration();
  draft.strategies[0].replicationPercent = '20';
  const review = t.runner.reviewEdit(draft);
  t.runner.cancelEdit();
  expect(() => t.runner.applyEdit(review.reviewKey, true)).toThrow(
    'Review and approve',
  );
  const again = t.runner.reviewEdit(draft);
  t.runner.resume();
  await flush();
  t.runner.pause();
  expect(() => t.runner.applyEdit(again.reviewKey, true)).toThrow(
    'Review and approve',
  );
  t.runner.stop();
});
