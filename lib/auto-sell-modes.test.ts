import { describe, expect, it, vi } from 'vitest';
import {
  applyAutoSellTrade,
  autoSellStrategyError,
  checkAutoSellEnd,
  dcaAmountRaw,
  initialAutoSellState,
  newAutoSellStrategy,
  readyToSellRaw,
  scheduleAutoSell,
  withAutoSellMode,
  type AutoSellObservedTrade,
  type AutoSellStrategy,
} from './auto-sell';
import { AutoSellRunner } from './auto-sell-runner';

const SUPPLY = 1_000_000_000_000_000n; // 1B tokens, 6 decimals
const BUYER = 'Buy1111111111111111111111111111111111111111';

const dca = (patch: Partial<AutoSellStrategy> = {}): AutoSellStrategy => ({
  ...withAutoSellMode(newAutoSellStrategy(0), 'dca'),
  dcaAmount: '0.1',
  dcaIntervalSeconds: 60,
  ...patch,
});
const limit = (
  rows: [string, string][],
  patch: Partial<AutoSellStrategy> = {},
): AutoSellStrategy => ({
  ...withAutoSellMode(newAutoSellStrategy(0), 'limit'),
  limitOrders: rows.map(([amount, marketCapUsd], i) => ({
    id: `r${i}`,
    amount,
    marketCapUsd,
  })),
  ...patch,
});
const ctx = (patch = {}) => ({
  now: 0,
  decimals: 6,
  totalSupplyRaw: SUPPLY,
  marketCapUsd: 50_000 as number | null,
  random: () => 0.5,
  ...patch,
});

describe('DCA and limit order rules', () => {
  it('renames default strategies and seeds one limit row', () => {
    const s = withAutoSellMode(newAutoSellStrategy(1), 'limit');
    expect(s.name).toBe('Limit Orders 2');
    expect(s.limitOrders).toHaveLength(1);
    expect(withAutoSellMode({ ...s, name: 'Mine' }, 'dca').name).toBe('Mine');
  });

  it('validates DCA amounts and interval', () => {
    expect(autoSellStrategyError(dca())).toBeNull();
    expect(autoSellStrategyError(dca({ dcaAmount: '' }))).toMatch(/Amount/);
    expect(autoSellStrategyError(dca({ dcaAmount: '101' }))).toMatch(/100%/);
    expect(autoSellStrategyError(dca({ dcaIntervalSeconds: 5 }))).toMatch(
      /Interval/,
    );
    expect(autoSellStrategyError(dca({ dcaIntervalSeconds: 86_401 }))).toMatch(
      /Interval/,
    );
    expect(
      autoSellStrategyError(
        dca({ dcaRandomized: true, dcaMinAmount: '0.2', dcaMaxAmount: '0.1' }),
      ),
    ).toMatch(/below Max/);
    expect(
      autoSellStrategyError(
        dca({
          amountUnit: 'tokens',
          dcaAmount: '5000000',
        }),
      ),
    ).toBeNull();
    expect(
      autoSellStrategyError(dca({ amountUnit: 'tokens', dcaAmount: '0' })),
    ).toMatch(/above 0/);
  });

  it('requires strictly rising limit targets', () => {
    expect(
      autoSellStrategyError(
        limit([
          ['1', '100000'],
          ['1', '200000'],
        ]),
      ),
    ).toBeNull();
    expect(
      autoSellStrategyError(
        limit([
          ['1', '200000'],
          ['1', '200000'],
        ]),
      ),
    ).toMatch(/higher than the order above/);
    expect(autoSellStrategyError(limit([['', '1']]))).toMatch(/amount/);
    expect(autoSellStrategyError(limit([]))).toMatch(/at least one/);
  });

  it('draws random DCA amounts inside the inclusive range', () => {
    const s = dca({
      dcaRandomized: true,
      dcaMinAmount: '0.1',
      dcaMaxAmount: '0.2',
    });
    const min = 1_000_000_000_000n;
    const max = 2_000_000_000_000n;
    expect(dcaAmountRaw(s, SUPPLY, 6, () => 0)).toBe(min);
    expect(dcaAmountRaw(s, SUPPLY, 6, () => 0.9999999)).toBe(max);
    const mid = dcaAmountRaw(s, SUPPLY, 6, () => 0.5);
    expect(mid > min && mid < max).toBe(true);
  });

  it('queues one DCA sell per interval without stacking', () => {
    const s = dca();
    let state = initialAutoSellState(0);
    let r = scheduleAutoSell(s, state, ctx());
    expect(r.addedRaw).toBe(1_000_000_000_000n);
    state = r.state;
    expect(state.nextDcaAt).toBe(60_000);
    // Still queued: nothing new even long after the interval.
    expect(scheduleAutoSell(s, state, ctx({ now: 600_000 })).addedRaw).toBe(0n);
    state = { ...state, bufferedRaw: 0n, soldRaw: 1_000_000_000_000n };
    expect(scheduleAutoSell(s, state, ctx({ now: 59_999 })).addedRaw).toBe(0n);
    r = scheduleAutoSell(s, state, ctx({ now: 600_000 }));
    expect(r.addedRaw).toBe(1_000_000_000_000n);
    expect(r.state.nextDcaAt).toBe(660_000);
  });

  it('pauses DCA out of range and clamps to the max amount', () => {
    const ranged = dca({ marketCapMinUsd: '100000' });
    const state = initialAutoSellState(0);
    expect(scheduleAutoSell(ranged, state, ctx()).addedRaw).toBe(0n);
    expect(
      scheduleAutoSell(ranged, state, ctx({ marketCapUsd: null })).addedRaw,
    ).toBe(0n);
    const capped = dca({ endMaxSupplyPercent: '0.15' });
    const after = {
      ...state,
      soldRaw: 1_000_000_000_000n,
      nextDcaAt: 0,
    };
    expect(scheduleAutoSell(capped, after, ctx()).addedRaw).toBe(
      500_000_000_000n,
    );
  });

  it('fills limit rows once each as the market cap rises', () => {
    const s = limit([
      ['0.1', '60000'],
      ['0.2', '80000'],
      ['0.3', '120000'],
    ]);
    let state = initialAutoSellState(0);
    expect(scheduleAutoSell(s, state, ctx()).addedRaw).toBe(0n);
    let r = scheduleAutoSell(s, state, ctx({ marketCapUsd: 90_000 }));
    expect(r.filled).toEqual(['r0', 'r1']);
    expect(r.addedRaw).toBe(3_000_000_000_000n);
    state = r.state;
    // Falling back does not re-sell filled rows.
    expect(
      scheduleAutoSell(s, state, ctx({ marketCapUsd: 90_000 })).filled,
    ).toEqual([]);
    state = { ...state, bufferedRaw: 0n };
    r = scheduleAutoSell(s, state, ctx({ marketCapUsd: 200_000 }));
    expect(r.filled).toEqual(['r2']);
    expect(
      checkAutoSellEnd(s, { ...r.state, bufferedRaw: 0n }, 0, SUPPLY).status,
    ).toBe('ended');
    expect(checkAutoSellEnd(s, r.state, 0, SUPPLY).status).toBe('running');
  });

  it('supports token amounts and ignores outside buys outside Counter', () => {
    const s = limit([['1500.5', '1']], { amountUnit: 'tokens' });
    expect(scheduleAutoSell(s, initialAutoSellState(0), ctx()).addedRaw).toBe(
      1_500_500_000n,
    );
    const trade = {
      id: 't',
      sender: BUYER,
      side: 'Buy' as const,
      tokenAmount: '1000',
      quoteAmount: '1',
      priceUsd: '0.00005',
    };
    const result = applyAutoSellTrade(dca(), initialAutoSellState(0), trade, {
      decimals: 6,
      totalSupplyRaw: SUPPLY,
      ownWallets: new Set(),
      marketCapUsd: 50_000,
      random: () => 0,
    });
    expect(result.outcome).toBe('not-counter');
    expect(result.addedRaw).toBe(0n);
  });

  it('ignores the counter minimum for DCA buffers', () => {
    const s = dca({ minSupplyPercentPerSell: '50' });
    const state = { ...initialAutoSellState(0), bufferedRaw: 5n };
    expect(readyToSellRaw(s, state, SUPPLY)).toBe(5n);
  });
});

describe('AutoSellRunner with DCA and limit orders', () => {
  const trade = (priceUsd: string): AutoSellObservedTrade => ({
    id: `p-${priceUsd}`,
    sender: BUYER,
    side: 'Sell',
    tokenAmount: '1',
    quoteAmount: '1',
    priceUsd,
    timestamp: new Date(0).toISOString(),
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));

  function setup(strategies: AutoSellStrategy[]) {
    let feed: AutoSellObservedTrade[] = [trade('0.00005')]; // $50k cap
    let now = 0;
    const sell = vi.fn(async (amount: bigint) => ({
      soldRaw: amount,
      signature: 'sig',
      wallet: BUYER,
    }));
    const runner = new AutoSellRunner({
      strategies,
      decimals: 6,
      totalSupplyRaw: SUPPLY,
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
      price: (p: string) => (feed = [trade(p), ...feed]),
      advance: (ms: number) => (now += ms),
    };
  }

  it('sells DCA at start and then every interval', async () => {
    const t = setup([{ ...dca(), id: 'd' }]);
    t.runner.start();
    await flush();
    expect(t.sell).toHaveBeenCalledTimes(1);
    expect(t.sell).toHaveBeenCalledWith(1_000_000_000_000n, expect.anything());
    t.advance(30_000);
    await t.runner.tick();
    await flush();
    expect(t.sell).toHaveBeenCalledTimes(1);
    t.advance(30_000);
    await t.runner.tick();
    await flush();
    expect(t.sell).toHaveBeenCalledTimes(2);
    expect(t.runner.snapshot().states.d.responses).toBe(2);
  });

  it('sells limit rows as the market cap rises, then ends', async () => {
    const t = setup([
      {
        ...limit([
          ['0.1', '60000'],
          ['0.2', '80000'],
        ]),
        id: 'l',
      },
    ]);
    t.runner.start();
    await flush();
    expect(t.sell).not.toHaveBeenCalled();
    t.price('0.00007'); // $70k
    await t.runner.tick();
    await flush();
    expect(t.sell).toHaveBeenLastCalledWith(
      1_000_000_000_000n,
      expect.anything(),
    );
    t.price('0.0001'); // $100k
    await t.runner.tick();
    await flush();
    expect(t.sell).toHaveBeenLastCalledWith(
      2_000_000_000_000n,
      expect.anything(),
    );
    await t.runner.tick();
    const snap = t.runner.snapshot();
    expect(snap.states.l.status).toBe('ended');
    expect(snap.states.l.endedReason).toBe('All limit orders filled');
    expect(snap.running).toBe(false);
  });
});
