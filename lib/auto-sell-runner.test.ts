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
});

function setup(
  patch = {},
  sell = vi.fn(async (amount: bigint) => ({
    soldRaw: amount,
    signature: 'sig',
    wallet: OWN,
  })),
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
});
