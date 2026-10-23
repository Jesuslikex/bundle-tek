import { expect, it, vi } from 'vitest';
import {
  autoSellStrategyError,
  checkAutoSellEnd,
  endCapRaw,
  applyAutoSellTrade,
  initialAutoSellState,
  newAutoSellStrategy,
  scheduleAutoSell,
} from './auto-sell';
import { autoSellSessionCap, autoSellSessionError } from './auto-sell-session';
import { AutoSellRunner } from './auto-sell-runner';
import { autoSellEditChanges } from './auto-sell-edit-changes';

const strategy = () => ({
  ...newAutoSellStrategy(0),
  id: 'counter',
  replicationPercent: '100',
  endMaxTokenAmount: '1.25',
});
const session = {
  startDelaySeconds: 0,
  endDurationSeconds: 0,
  endMaxSupplyPercent: '',
  endMaxTokenAmount: '1.25',
};
const supply = 100_000n;
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

it('retains the exact legacy percentage cap and optional blank behavior', () => {
  const old = {
    ...strategy(),
    endMaxTokenAmount: undefined,
    endMaxSupplyPercent: '1',
  };
  expect(endCapRaw(old, supply)).toBe(1000n);
  expect(
    autoSellSessionCap(
      { ...session, endMaxTokenAmount: undefined, endMaxSupplyPercent: '1' },
      supply,
    ),
  ).toBe(1000n);
  expect(endCapRaw({ ...old, endMaxSupplyPercent: '' }, supply)).toBeNull();
  expect(
    endCapRaw({ ...strategy(), endMaxTokenAmount: '' }, supply, 2),
  ).toBeNull();
});

it.each([
  [0, '125', 125n],
  [2, '1.25', 125n],
  [6, '0.000125', 125n],
  [9, '0.000000125', 125n],
  [2, '1.2500', 125n],
] as const)(
  'converts token maximum exactly at precision %s',
  (decimals, amount, raw) => {
    expect(
      endCapRaw({ ...strategy(), endMaxTokenAmount: amount }, supply, decimals),
    ).toBe(raw);
    expect(
      autoSellSessionCap(
        { ...session, endMaxTokenAmount: amount },
        supply,
        decimals,
      ),
    ).toBe(raw);
  },
);

it.each(['0', '0.000', '-1', '1e2', 'NaN', '1,000', ' 1', '1.'])(
  'refuses malformed token maximum %s',
  (amount) => {
    const s = { ...strategy(), endMaxTokenAmount: amount };
    expect(autoSellStrategyError(s)).toBeTruthy();
    expect(
      autoSellSessionError({ ...session, endMaxTokenAmount: amount }),
    ).toBeTruthy();
    expect(() => endCapRaw(s, supply, 2)).toThrow();
  },
);

it.each(['0.001', '1.251', '1000.01'])(
  'refuses precision or supply excess %s rather than rounding',
  (amount) => {
    expect(() =>
      endCapRaw({ ...strategy(), endMaxTokenAmount: amount }, supply, 2),
    ).toThrow();
    expect(() =>
      autoSellSessionCap({ ...session, endMaxTokenAmount: amount }, supply, 2),
    ).toThrow();
  },
);

it('preserves integer caps above the JavaScript safe-number range', () => {
  const amount = '9007199254740993.123456789';
  const raw = 9007199254740993123456789n;
  expect(endCapRaw({ ...strategy(), endMaxTokenAmount: amount }, raw, 9)).toBe(
    raw,
  );
  expect(
    autoSellSessionCap({ ...session, endMaxTokenAmount: amount }, raw, 9),
  ).toBe(raw);
});

it('refuses ambiguous caps and missing token precision', () => {
  expect(() =>
    endCapRaw({ ...strategy(), endMaxSupplyPercent: '1' }, supply, 2),
  ).toThrow(/one maximum/);
  expect(() =>
    autoSellSessionCap({ ...session, endMaxSupplyPercent: '1' }, supply, 2),
  ).toThrow(/one maximum/);
  expect(() => endCapRaw(strategy(), supply)).toThrow(/precision/);
  expect(() => autoSellSessionCap(session, supply)).toThrow(/precision/);
});

it('clips Counter scheduling with the exact token cap and includes queued/in-flight/accounted amounts', () => {
  const result = applyAutoSellTrade(
    strategy(),
    {
      ...initialAutoSellState(0),
      soldRaw: 50n,
      inFlightRaw: 25n,
      bufferedRaw: 20n,
    },
    {
      id: 'trade',
      sender: 'OUTSIDE',
      side: 'Buy',
      tokenAmount: '5',
      quoteAmount: '1',
      priceUsd: '1',
    },
    {
      decimals: 2,
      totalSupplyRaw: supply,
      ownWallets: new Set(),
      marketCapUsd: null,
      random: () => 0,
    },
  );
  expect(result.addedRaw).toBe(30n);
  expect(result.state.bufferedRaw).toBe(50n);
  expect(
    checkAutoSellEnd(
      strategy(),
      { ...result.state, soldRaw: 125n, inFlightRaw: 0n, bufferedRaw: 0n },
      0,
      supply,
      null,
      2,
    ).status,
  ).toBe('ended');
});

it.each(['dca', 'limit'] as const)(
  'clips %s scheduling with the same token cap',
  (mode) => {
    const s = {
      ...strategy(),
      mode,
      amountUnit: 'tokens' as const,
      dcaAmount: '10',
      dcaIntervalSeconds: 10,
      limitOrders: [{ id: 'limit', amount: '10', marketCapUsd: '1' }],
    };
    const result = scheduleAutoSell(s, initialAutoSellState(0), {
      now: 0,
      decimals: 2,
      totalSupplyRaw: supply,
      marketCapUsd: 100,
      random: () => 0,
    });
    expect(result.addedRaw).toBe(125n);
  },
);

it('keeps a token cap below the Counter minimum from sending', () => {
  const s = { ...strategy(), minSupplyPercentPerSell: '1' };
  expect(
    checkAutoSellEnd(s, initialAutoSellState(0), 0, supply, null, 2),
  ).toMatchObject({
    status: 'ended',
    endedReason: 'Remaining strategy cap is below the minimum sell',
  });
});

it('enforces a shared token cap through dispatch, reviewed unit changes and retained accounting', async () => {
  const sell = vi.fn(async (amount: bigint) => ({
    soldRaw: amount,
    signature: 'SYNTHETIC',
    wallet: 'SYNTHETIC',
  }));
  const runner = new AutoSellRunner({
    strategies: [
      {
        ...strategy(),
        mode: 'dca',
        amountUnit: 'tokens',
        dcaAmount: '1',
        dcaIntervalSeconds: 10,
        endMaxTokenAmount: '',
      },
    ],
    decimals: 2,
    totalSupplyRaw: supply,
    ownWallets: new Set(),
    session,
    readTrades: async () => [],
    sell,
    onUpdate: () => {},
    now: () => 0,
    random: () => 0,
    setTimer: () => null,
    clearTimer: () => {},
  });
  try {
    runner.start();
    await flush();
    expect(sell.mock.calls.map((c) => c[0])).toEqual([100n]);
    runner.pause();
    const before = runner.configuration(),
      after = structuredClone(before);
    after.session.endMaxTokenAmount = undefined;
    after.session.endMaxSupplyPercent = '0.05';
    const review = runner.reviewEdit(after);
    expect(autoSellEditChanges(before, after)).toContainEqual({
      label: 'Session maximum',
      before: '1.25 tokens',
      after: '0.05% supply',
    });
    expect(review.endsSession).toBe(true);
    expect(() => runner.applyEdit(review.reviewKey, false)).toThrow();
    runner.applyEdit(review.reviewKey, true);
    expect(runner.snapshot().accountedRaw).toBe(100n);
    expect(runner.isRunning()).toBe(false);
    expect(sell).toHaveBeenCalledOnce();
  } finally {
    runner.stop();
  }
});

it('rejects invalid token limits before a runner starts or an edit mutates it', async () => {
  const deps = {
    strategies: [strategy()],
    decimals: 2,
    totalSupplyRaw: supply,
    ownWallets: new Set<string>(),
    readTrades: async () => [],
    sell: vi.fn(),
    onUpdate: () => {},
    setTimer: () => null,
    clearTimer: () => {},
  };
  expect(
    () =>
      new AutoSellRunner({
        ...deps,
        strategies: [{ ...strategy(), endMaxTokenAmount: '0.001' }],
      }),
  ).toThrow(/precision/);
  const runner = new AutoSellRunner(deps);
  try {
    runner.start();
    await flush();
    runner.pause();
    const next = runner.configuration();
    next.strategies[0].endMaxTokenAmount = '0.001';
    expect(() => runner.reviewEdit(next)).toThrow(/precision/);
    expect(runner.configuration().strategies[0].endMaxTokenAmount).toBe('1.25');
  } finally {
    runner.stop();
  }
});
