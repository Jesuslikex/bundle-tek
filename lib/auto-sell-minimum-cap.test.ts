import { expect, it, vi } from 'vitest';
import {
  checkAutoSellEnd,
  initialAutoSellState,
  newAutoSellStrategy,
  readyToSellRaw,
  type AutoSellObservedTrade,
} from './auto-sell';
import { AutoSellRunner } from './auto-sell-runner';

const supply = 10000n;
const counter = () => ({
  ...newAutoSellStrategy(0),
  id: 'counter',
  replicationPercent: '100',
  minSupplyPercentPerSell: '0.5',
  endMaxSupplyPercent: '1',
});

it('ends an unfillable strategy cap without selling below the selected minimum', () => {
  const s = counter();
  const state = { ...initialAutoSellState(0), soldRaw: 60n, bufferedRaw: 40n };
  expect(readyToSellRaw(s, state, supply)).toBe(0n);
  const next = checkAutoSellEnd(s, state, 1000, supply);
  expect(next.status).toBe('ended');
  expect(next.endedReason).toMatch(/remaining.*cap.*minimum/i);
  expect(next.soldRaw).toBe(60n);
  expect(next.bufferedRaw).toBe(0n);
});

it('keeps the exact-minimum boundary available', () => {
  const s = counter();
  const state = { ...initialAutoSellState(0), soldRaw: 50n, bufferedRaw: 50n };
  expect(checkAutoSellEnd(s, state, 1000, supply)).toBe(state);
  expect(readyToSellRaw(s, state, supply)).toBe(50n);
});

it('waits for an in-flight outcome rather than declaring temporary cap room unfillable', () => {
  const s = counter();
  const state = {
    ...initialAutoSellState(0),
    soldRaw: 60n,
    inFlightRaw: 40n,
    bufferedRaw: 0n,
  };
  expect(checkAutoSellEnd(s, state, 1000, supply)).toBe(state);
});

it.each([
  { firstSold: 49, outsideRange: false },
  { firstSold: 50, outsideRange: false },
  { firstSold: 51, outsideRange: false },
  { firstSold: 60, outsideRange: false },
  { firstSold: 60, outsideRange: true },
])(
  'preserves the Counter minimum at the shared session cap: %j',
  async ({ firstSold: firstSoldCount, outsideRange }) => {
    const firstSold = BigInt(firstSoldCount);
    let now = 0;
    let trades: AutoSellObservedTrade[] = [];
    const c = {
      ...counter(),
      endMaxSupplyPercent: '',
      marketCapMinUsd: outsideRange ? '100000' : '',
    };
    const dca = {
      ...newAutoSellStrategy(1),
      id: 'dca',
      mode: 'dca' as const,
      amountUnit: 'tokens' as const,
      dcaAmount: firstSold.toString(),
      dcaIntervalSeconds: 60,
    };
    const sell = vi.fn(async (amount: bigint, _signal: AbortSignal) => ({
      soldRaw: amount,
      signature: 'SYNTHETIC_ONLY',
      wallet: 'SYNTHETIC_ONLY',
    }));
    const runner = new AutoSellRunner({
      strategies: [dca, c],
      decimals: 0,
      totalSupplyRaw: supply,
      ownWallets: new Set(),
      session: {
        startDelaySeconds: 0,
        endDurationSeconds: 0,
        endMaxSupplyPercent: '1',
      },
      readTrades: async () => trades,
      sell,
      onUpdate: () => {},
      now: () => now,
      random: () => 0,
      setTimer: () => null,
      clearTimer: () => {},
    });
    const flush = async () => {
      for (let i = 0; i < 12; i++) await Promise.resolve();
    };
    try {
      runner.start();
      await flush();
      expect(sell.mock.calls.map(([amount]) => amount)).toEqual([firstSold]);
      now = 1000;
      trades = [
        {
          id: 'outside-buy',
          sender: 'OUTSIDE',
          side: 'Buy',
          tokenAmount: '100',
          quoteAmount: '1',
          priceUsd: '1',
          timestamp: new Date(now).toISOString(),
        },
      ];
      await runner.tick();
      await flush();
      const minimumFits = 100n - firstSold >= 50n;
      expect(sell.mock.calls.map(([amount]) => amount)).toEqual(
        minimumFits ? [firstSold, 100n - firstSold] : [firstSold],
      );
      if (minimumFits) {
        expect(runner.snapshot().accountedRaw).toBe(100n);
        expect(runner.isRunning()).toBe(false);
      } else {
        expect(runner.snapshot().states.counter.status).toBe('ended');
        expect(runner.snapshot().states.counter.endedReason).toMatch(
          /cap.*minimum/i,
        );
        expect(runner.snapshot().states.dca.status).toBe('running');
        expect(runner.snapshot().accountedRaw).toBe(firstSold);
        await runner.tick();
        await flush();
        expect(
          runner
            .snapshot()
            .log.filter(
              (entry) =>
                entry.strategyId === 'counter' &&
                entry.text.includes('cap is below the minimum'),
            ),
        ).toHaveLength(1);
      }
    } finally {
      runner.stop();
    }
  },
);

it('continues waiting below the minimum when no amount cap exists', () => {
  const s = { ...counter(), endMaxSupplyPercent: '' };
  const state = { ...initialAutoSellState(0), soldRaw: 60n, bufferedRaw: 40n };
  expect(checkAutoSellEnd(s, state, 1000, supply)).toBe(state);
  expect(readyToSellRaw(s, state, supply)).toBe(0n);
});
it('does not apply a Counter-only minimum to DCA', () => {
  const s = { ...counter(), mode: 'dca' as const };
  const state = { ...initialAutoSellState(0), soldRaw: 60n, bufferedRaw: 40n };
  expect(checkAutoSellEnd(s, state, 1000, supply)).toBe(state);
  expect(readyToSellRaw(s, state, supply)).toBe(40n);
});

it('finishes a sole strategy whose shared cap cannot meet its minimum, without submitting a sell', async () => {
  const sell = vi.fn();
  const runner = new AutoSellRunner({
    strategies: [{ ...counter(), endMaxSupplyPercent: '' }],
    decimals: 0,
    totalSupplyRaw: supply,
    ownWallets: new Set(),
    session: {
      startDelaySeconds: 0,
      endDurationSeconds: 0,
      endMaxSupplyPercent: '0.4',
    },
    readTrades: async () => [],
    sell,
    onUpdate: () => {},
    now: () => 0,
    setTimer: () => null,
    clearTimer: () => {},
  });
  try {
    runner.start();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(runner.isRunning()).toBe(false);
    expect(sell).not.toHaveBeenCalled();
    expect(runner.snapshot().states.counter.endedReason).toMatch(
      /cap.*minimum/i,
    );
    expect(runner.snapshot().accountedRaw).toBe(0n);
  } finally {
    runner.stop();
  }
});

const flushMinimum = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};
async function editableMinimumFixture(
  sell = vi.fn(async (amount: bigint, _signal: AbortSignal) => ({
    soldRaw: amount,
    signature: 'SYNTHETIC_ONLY',
    wallet: 'SYNTHETIC_ONLY',
  })),
  now: () => number = () => 0,
) {
  const runner = new AutoSellRunner({
    strategies: [
      {
        ...newAutoSellStrategy(1),
        id: 'dca',
        mode: 'dca',
        amountUnit: 'tokens',
        dcaAmount: '60',
        dcaIntervalSeconds: 60,
      },
      { ...counter(), endMaxSupplyPercent: '' },
    ],
    decimals: 0,
    totalSupplyRaw: supply,
    ownWallets: new Set(),
    session: {
      startDelaySeconds: 0,
      endDurationSeconds: 0,
      endMaxSupplyPercent: '1',
    },
    readTrades: async () => [],
    sell,
    onUpdate: () => {},
    now,
    setTimer: () => null,
    clearTimer: () => {},
  });
  runner.start();
  await flushMinimum();
  return { runner, sell };
}

it.each([false, true])(
  'review and apply agree on reactivation when session cap is raised=%s',
  async (raised) => {
    const f = await editableMinimumFixture();
    try {
      expect(f.runner.snapshot().states.counter.status).toBe('ended');
      f.runner.pause();
      const config = f.runner.configuration();
      if (raised) config.session.endMaxSupplyPercent = '2';
      else config.strategies[1].name = 'Renamed Counter';
      const review = f.runner.reviewEdit(config);
      expect(review.reactivatedStrategies).toEqual(raised ? ['Counter'] : []);
      f.runner.applyEdit(review.reviewKey, true);
      expect(f.runner.snapshot().paused).toBe(true);
      expect(f.runner.snapshot().states.counter.status).toBe(
        raised ? 'running' : 'ended',
      );
      expect(f.runner.snapshot().accountedRaw).toBe(60n);
      f.runner.resume();
      await flushMinimum();
      expect(f.runner.snapshot().states.counter.status).toBe(
        raised ? 'running' : 'ended',
      );
      expect(f.sell).toHaveBeenCalledOnce();
    } finally {
      f.runner.stop();
    }
  },
);

it('does not end another strategy using room temporarily occupied by a pending sell', async () => {
  let reject!: (error: Error) => void;
  const sell = vi.fn(
    (_amount: bigint, _signal: AbortSignal) =>
      new Promise<{ soldRaw: bigint; signature: string; wallet: string }>(
        (_resolve, fail) => {
          reject = fail;
        },
      ),
  );
  const f = await editableMinimumFixture(sell);
  try {
    expect(f.runner.snapshot().selling).toBe(true);
    expect(f.runner.snapshot().states.counter.status).toBe('running');
    await f.runner.tick();
    await flushMinimum();
    expect(f.runner.snapshot().states.counter.status).toBe('running');
    reject(new Error('Synthetic unsigned refusal'));
    await flushMinimum();
    expect(f.runner.snapshot().states.counter.status).toBe('running');
    expect(f.runner.snapshot().accountedRaw).toBe(0n);
    expect(sell).toHaveBeenCalledOnce();
  } finally {
    f.runner.stop();
  }
});

it.each([40, 50, null])(
  'uses the same pure minimum check for stable shared room %s',
  (room) => {
    const s = { ...counter(), endMaxSupplyPercent: '' };
    const state = initialAutoSellState(0);
    const next = checkAutoSellEnd(
      s,
      state,
      0,
      supply,
      room === null ? null : BigInt(room),
    );
    expect(next.status).toBe(room === 40 ? 'ended' : 'running');
    if (room === 40) expect(next.endedReason).toMatch(/session cap.*minimum/i);
  },
);

it('reviews every strategy ended by new limits and warns when the whole session ends', async () => {
  const c = { ...counter(), endMaxSupplyPercent: '' };
  let trades: AutoSellObservedTrade[] = [];
  const sell = vi.fn();
  const runner = new AutoSellRunner({
    strategies: [c],
    decimals: 0,
    totalSupplyRaw: supply,
    ownWallets: new Set(),
    session: {
      startDelaySeconds: 0,
      endDurationSeconds: 0,
      endMaxSupplyPercent: '1',
    },
    readTrades: async () => trades,
    sell,
    onUpdate: () => {},
    now: () => 0,
    random: () => 0,
    setTimer: () => null,
    clearTimer: () => {},
  });
  try {
    runner.start();
    await flushMinimum();
    trades = [
      {
        id: 'queued',
        sender: 'OUTSIDE',
        side: 'Buy',
        tokenAmount: '40',
        quoteAmount: '1',
        priceUsd: '1',
      },
    ];
    await runner.tick();
    await flushMinimum();
    expect(runner.snapshot().states.counter.bufferedRaw).toBe(40n);
    runner.pause();
    const config = runner.configuration();
    config.session.endMaxSupplyPercent = '0.4';
    const review = runner.reviewEdit(config);
    expect(review.endsSession).toBe(true);
    expect(review.endingStrategies).toEqual([
      {
        id: 'counter',
        name: 'Counter',
        reason: 'Remaining session cap is below the minimum sell',
      },
    ]);
    expect(review.cancelledQueuedRaw).toBe('40');
    expect(() => runner.applyEdit(review.reviewKey, false)).toThrow();
    expect(runner.isRunning()).toBe(true);
    runner.applyEdit(review.reviewKey, true);
    expect(runner.isRunning()).toBe(false);
    expect(runner.snapshot().accountedRaw).toBe(0n);
    expect(sell).not.toHaveBeenCalled();
  } finally {
    runner.stop();
  }
});

it('requires a fresh edit review if elapsed time changes its promised reactivation', async () => {
  let now = 0;
  const f = await editableMinimumFixture(undefined, () => now);
  try {
    f.runner.pause();
    const config = f.runner.configuration();
    config.session.endMaxSupplyPercent = '2';
    config.strategies[1].endDurationSeconds = 1;
    const review = f.runner.reviewEdit(config);
    expect(review.reactivatedStrategies).toEqual(['Counter']);
    now = 2000;
    expect(() => f.runner.applyEdit(review.reviewKey, true)).toThrow(
      'Ending conditions changed',
    );
    expect(f.runner.configuration().session.endMaxSupplyPercent).toBe('1');
    expect(f.runner.snapshot().configurationRevision).toBe(1);
    expect(f.runner.snapshot().accountedRaw).toBe(60n);
  } finally {
    f.runner.stop();
  }
});
