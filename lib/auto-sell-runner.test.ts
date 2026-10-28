import { describe, expect, it, vi } from 'vitest';
import { newAutoSellStrategy, type AutoSellObservedTrade } from './auto-sell';
import { AutoSellRunner } from './auto-sell-runner';
import { AutoSellUncertainError } from './auto-sell-execute';

const SUPPLY = 1_000_000_000_000_000n;
const OWN = 'Own1111111111111111111111111111111111111111';
let n = 0;
const buy = (
  tokenAmount: string,
  sender = 'Buy1111111111111111111111111111111111111111',
  priceUsd = '0.00005',
): AutoSellObservedTrade => ({
  id: `t${n++}`,
  sender,
  side: 'Buy',
  tokenAmount,
  quoteAmount: '1',
  priceUsd,
  timestamp: new Date(0).toISOString(),
});

function setup(
  patch = {},
  sell = vi.fn(async (amount: bigint) => ({
    soldRaw: amount,
    signature: 'sig',
    wallet: OWN,
  })),
  onSold?: (entry: {
    strategyId: string;
    wallet: string;
    soldRaw: bigint;
    signature: string;
  }) => void,
) {
  let feed: AutoSellObservedTrade[] = [];
  let now = 0;
  const strategies = [
    { ...newAutoSellStrategy(0), id: 'a', replicationPercent: '50', ...patch },
    { ...newAutoSellStrategy(1), id: 'b', replicationPercent: '10' },
  ];
  const runner = new AutoSellRunner({
    strategies,
    decimals: 6,
    totalSupplyRaw: SUPPLY,
    ownWallets: new Set([OWN]),
    readTrades: async () => feed,
    sell,
    onUpdate: () => {},
    ...(onSold ? { onSold } : {}),
    now: () => now,
    random: () => 0,
    setTimer: () => null,
    clearTimer: () => {},
  });
  return {
    runner,
    sell,
    push: (...trades: AutoSellObservedTrade[]) =>
      (feed = [...trades.reverse(), ...feed]),
    advance: (ms: number) => (now += ms),
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('AutoSellRunner', () => {
  it('ignores history, then sells on new outside buys', async () => {
    const t = setup();
    t.push(buy('1000'));
    t.runner.start();
    await flush();
    expect(t.sell).not.toHaveBeenCalled();
    t.push(buy('1000'), buy('5', OWN));
    await t.runner.tick();
    await flush();
    expect(t.sell).toHaveBeenCalledWith(500_000_000n, expect.anything());
    await t.runner.tick();
    await flush();
    expect(t.sell).toHaveBeenCalledWith(100_000_000n, expect.anything());
    const snap = t.runner.snapshot();
    expect(snap.states.a.soldRaw).toBe(500_000_000n);
    expect(snap.states.b.soldRaw).toBe(100_000_000n);
  });

  it('holds sells while out of the market cap range', async () => {
    const t = setup({ marketCapMinUsd: '100000' });
    t.runner.start();
    await flush();
    t.push(buy('1000'));
    await t.runner.tick();
    await flush();
    expect(t.runner.snapshot().states.a.inRange).toBe(false);
    expect(t.sell).not.toHaveBeenCalledWith(500_000_000n, expect.anything());
  });

  it('ends one strategy at its duration while others continue', async () => {
    const t = setup({ endDurationSeconds: 10 });
    t.runner.start();
    await flush();
    t.advance(10_000);
    await t.runner.tick();
    const snap = t.runner.snapshot();
    expect(snap.states.a.status).toBe('ended');
    expect(snap.states.b.status).toBe('running');
    expect(snap.running).toBe(true);
  });

  it('requeues a failed sell but never resells an uncertain one', async () => {
    const sell = vi
      .fn()
      .mockRejectedValueOnce(new Error('balance'))
      .mockRejectedValueOnce(new AutoSellUncertainError('unknown', 'sig', OWN));
    const t = setup({}, sell);
    t.runner.start();
    await flush();
    t.push(buy('1000'));
    await t.runner.tick();
    await flush();
    expect(t.runner.snapshot().states.a.bufferedRaw).toBe(500_000_000n);
    t.advance(20_000);
    await t.runner.tick();
    await flush();
    const a = t.runner.snapshot().states.a;
    expect(a.bufferedRaw).toBe(0n);
    expect(a.soldRaw).toBe(500_000_000n);
  });

  it('stop halts everything', async () => {
    const t = setup();
    t.runner.start();
    await flush();
    t.runner.stop();
    expect(t.runner.snapshot().states.a.status).toBe('stopped');
    expect(t.runner.isRunning()).toBe(false);
  });

  it('stops the whole run after repeated failed sells', async () => {
    const sell = vi.fn().mockRejectedValue(new Error('balance'));
    const t = setup({}, sell);
    t.runner.start();
    await flush();
    t.push(buy('1000'));
    for (let i = 0; i < 8; i++) {
      await t.runner.tick();
      await flush();
      t.advance(20_000);
    }
    expect(sell).toHaveBeenCalledTimes(5);
    expect(t.runner.isRunning()).toBe(false);
    expect(t.runner.snapshot().states.a.status).toBe('stopped');
  });

  it('treats a stale market cap as unknown and holds ranged sells', async () => {
    const t = setup({ marketCapMinUsd: '1', minSupplyPercentPerSell: '50' });
    let failing = false;
    const runner = t.runner as unknown as {
      deps: { readTrades: (s: AbortSignal) => Promise<unknown> };
    };
    const read = runner.deps.readTrades;
    runner.deps.readTrades = async (signal) => {
      if (failing) throw new Error('feed down');
      return read(signal);
    };
    t.runner.start();
    await flush();
    t.push(buy('1000'));
    await t.runner.tick();
    expect(t.runner.snapshot().marketCapUsd).not.toBeNull();
    failing = true;
    t.advance(61_000);
    await t.runner.tick();
    expect(t.runner.snapshot().marketCapUsd).toBeNull();
    expect(t.runner.snapshot().states.a.inRange).toBe(false);
  });
});

it('reports each landed sell to the journalling hook and survives a throwing one', async () => {
  const sold: { strategyId: string; wallet: string; soldRaw: bigint }[] = [];
  const t = setup(
    {},
    vi.fn(async (amount: bigint) => ({
      soldRaw: amount,
      signature: 'sig',
      wallet: OWN,
    })),
    (entry) => {
      sold.push(entry);
      throw Error('journal down');
    },
  );
  t.push(buy('1000'));
  t.runner.start();
  await flush();
  t.push(buy('1000'));
  await t.runner.tick();
  await flush();
  // Both harness strategies fire; each landed sell is reported once.
  expect(sold).toHaveLength(2);
  const first = sold.find((e) => e.strategyId === 'a')!;
  expect(first).toMatchObject({ wallet: OWN });
  expect(first.soldRaw).toBe(500_000_000n);
  // The throw must not have failed the sell.
  expect(t.runner.snapshot().states.a.soldRaw).toBe(500_000_000n);
});