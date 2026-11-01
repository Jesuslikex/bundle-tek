import { describe, expect, it, vi } from 'vitest';
import {
  AutoBuyRunner,
  decimalToLamports,
  validateAutoBuy,
  type AutoBuyStrategy,
} from './auto-buy-run';
import type { AutoSellObservedTrade } from './auto-sell';

const SOL = 'So11111111111111111111111111111111111111112';
const T = 1_700_000_000_000;
const iso = (ms: number) =>
  new Date(ms).toISOString().replace(/\.\d{3}Z$/, '.000Z');
const trade = (
  id: string,
  side: 'Buy' | 'Sell',
  sol: string,
  sender = 'outside',
  at = T,
): AutoSellObservedTrade => ({
  id,
  sender,
  side,
  tokenAmount: '1000',
  quoteAmount: sol,
  quoteMint: SOL,
  priceUsd: '0.0001',
  timestamp: iso(at),
});
const LAMPORTS = 1_000_000_000n;

function setup(
  strategies: AutoBuyStrategy[],
  opts: {
    budget?: bigint;
    feeds?: AutoSellObservedTrade[][];
    buyFails?: unknown;
    random?: number;
    rules?: object;
  } = {},
) {
  let clock = T;
  const feeds = opts.feeds ?? [[]];
  let call = 0;
  const buy = vi.fn(async (lamports: bigint) => {
    if (opts.buyFails) throw opts.buyFails;
    return {
      signature: `sig${buy.mock.calls.length}`,
      wallet: 'Wallet1',
      lamports,
    };
  });
  const runner = new AutoBuyRunner({
    strategies,
    rules: {
      budgetLamports: opts.budget ?? 10n * LAMPORTS,
      whitelist: ['friend'],
      ...opts.rules,
    },
    decimals: 6,
    totalSupplyRaw: 1_000_000_000n * 1_000_000n, // 1B tokens
    ownWallets: new Set(['mine']),
    readTrades: async () => feeds[Math.min(call++, feeds.length - 1)],
    buy,
    isUncertain: (e) => (e as { uncertain?: boolean })?.uncertain === true,
    onUpdate: () => {},
    now: () => clock,
    random: () => opts.random ?? 0,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  return { runner, buy, advance: (ms: number) => (clock += ms) };
}

describe('Auto Buy validation', () => {
  it('requires a budget and ordered limit targets', () => {
    expect(() =>
      validateAutoBuy([], { budgetLamports: 0n, whitelist: [] }),
    ).toThrow(/budget/);
    expect(() =>
      validateAutoBuy(
        [
          {
            id: 'l',
            kind: 'Limit',
            rows: [
              { marketCapUsd: 50000, lamports: 1n },
              { marketCapUsd: 60000, lamports: 1n },
            ],
          },
        ],
        { budgetLamports: 1n, whitelist: [] },
      ),
    ).toThrow(/lower/);
    expect(() =>
      validateAutoBuy(
        [
          {
            id: 'd',
            kind: 'DCA',
            intervalSeconds: 86401,
            minLamports: 1n,
            maxLamports: 1n,
          },
        ],
        { budgetLamports: 1n, whitelist: [] },
      ),
    ).toThrow(/24 hours/);
  });
  it('parses feed SOL amounts', () => {
    expect(decimalToLamports('1.5')).toBe(1_500_000_000n);
    expect(decimalToLamports('0.0000000019')).toBe(1n);
    expect(decimalToLamports('abc')).toBeNull();
  });
});

describe('Auto Buy counter', () => {
  const counter: AutoBuyStrategy = {
    id: 'c',
    kind: 'Counter',
    ratePercent: 100,
    minSolLamports: LAMPORTS / 10n,
    minTokens: 0,
    replicationPercent: 20,
    minPerTradeLamports: 0n,
  };
  it('buys a share of outside sells after the first read, ignoring own, whitelisted, buys and small sells', async () => {
    const { runner, buy } = setup([counter], {
      feeds: [
        [trade('old', 'Sell', '5')],
        [
          trade('a', 'Sell', '2'),
          trade('b', 'Sell', '9', 'mine'),
          trade('c', 'Sell', '9', 'friend'),
          trade('d', 'Buy', '9'),
          trade('e', 'Sell', '0.01'),
          trade('old', 'Sell', '5'),
        ],
      ],
    });
    runner.start();
    await runner.tick(); // primes history: 'old' is not countered
    expect(buy).not.toHaveBeenCalled();
    await runner.tick();
    expect(buy).toHaveBeenCalledOnce();
    expect(buy.mock.calls[0][0]).toBe(400_000_000n); // 20% of 2 SOL
  });
  it('rate gates the response', async () => {
    const { runner, buy } = setup([{ ...counter, ratePercent: 40 }], {
      random: 0.5,
      feeds: [[], [trade('a', 'Sell', '2')]],
    });
    runner.start();
    await runner.tick();
    await runner.tick();
    expect(buy).not.toHaveBeenCalled();
  });
  it('accumulates up to the minimum per trade', async () => {
    const { runner, buy } = setup(
      [{ ...counter, minPerTradeLamports: 500_000_000n }],
      {
        feeds: [
          [],
          [trade('a', 'Sell', '1')],
          [trade('b', 'Sell', '2'), trade('a', 'Sell', '1')],
        ],
      },
    );
    runner.start();
    await runner.tick();
    await runner.tick();
    expect(buy).not.toHaveBeenCalled(); // 0.2 SOL buffered
    await runner.tick();
    expect(buy.mock.calls[0][0]).toBe(600_000_000n);
  });
});

describe('Auto Buy budget and stops', () => {
  const dca: AutoBuyStrategy = {
    id: 'd',
    kind: 'DCA',
    intervalSeconds: 60,
    minLamports: LAMPORTS,
    maxLamports: LAMPORTS,
  };
  it('never spends past the hard budget and stops when it is used', async () => {
    const { runner, buy, advance } = setup([dca], { budget: 1_500_000_000n });
    runner.start();
    await runner.tick(); // primes
    await runner.tick(); // buys 1 SOL
    advance(60_000);
    await runner.tick(); // buys the remaining 0.5
    expect(buy.mock.calls.map((c) => c[0])).toEqual([LAMPORTS, 500_000_000n]);
    advance(60_000);
    await runner.tick();
    expect(buy).toHaveBeenCalledTimes(2);
    expect(runner.snapshot().running).toBe(false);
    expect(runner.snapshot().endedReason).toMatch(/budget/);
  });
  it('charges and stops on a signed buy with unknown outcome', async () => {
    const { runner, buy } = setup([dca], {
      buyFails: Object.assign(new Error('unknown'), { uncertain: true }),
    });
    runner.start();
    await runner.tick();
    await runner.tick();
    expect(buy).toHaveBeenCalledOnce();
    expect(runner.snapshot().spentLamports).toBe(LAMPORTS);
    expect(runner.snapshot().running).toBe(false);
  });
  it('stops after repeated plain failures', async () => {
    const { runner, advance } = setup([{ ...dca, intervalSeconds: 1 }], {
      buyFails: new Error('route'),
    });
    runner.start();
    for (let i = 0; i < 7; i++) {
      await runner.tick();
      advance(1000);
    }
    expect(runner.snapshot().endedReason).toMatch(/5 failed/);
  });
  it('respects start delay, pause and stop', async () => {
    const { runner, buy, advance } = setup([dca], {
      rules: { startDelaySeconds: 30 },
    });
    runner.start();
    await runner.tick();
    await runner.tick();
    expect(buy).not.toHaveBeenCalled();
    advance(30_000);
    runner.pause();
    await runner.tick();
    expect(buy).not.toHaveBeenCalled();
    runner.resume();
    await runner.tick();
    expect(buy).toHaveBeenCalledOnce();
    runner.stop();
    advance(120_000);
    await runner.tick();
    expect(buy).toHaveBeenCalledOnce();
  });
  it('ends a strategy at its own amount cap', async () => {
    const { runner, buy, advance } = setup([
      { ...dca, endLamports: 1_500_000_000n },
    ]);
    runner.start();
    await runner.tick();
    await runner.tick();
    advance(60_000);
    await runner.tick();
    advance(60_000);
    await runner.tick();
    expect(buy.mock.calls.map((c) => c[0])).toEqual([LAMPORTS, 500_000_000n]);
    expect(runner.snapshot().states.d.status).toBe('ended');
  });
});

describe('Auto Buy limit orders and market cap range', () => {
  it('fills each descending target once as the market cap falls', async () => {
    // price 0.0001 * 1B = $100k
    const at = (p: string, id: string) => ({
      ...trade(id, 'Buy', '1'),
      priceUsd: p,
    });
    const { runner, buy } = setup(
      [
        {
          id: 'l',
          kind: 'Limit',
          rows: [
            { marketCapUsd: 90000, lamports: 1n },
            { marketCapUsd: 60000, lamports: 2n },
          ],
        },
      ],
      {
        feeds: [
          [at('0.0001', 'a')],
          [at('0.00008', 'b')],
          [at('0.00008', 'c')],
          [at('0.00005', 'd')],
        ],
      },
    );
    runner.start();
    await runner.tick(); // $100k: nothing
    await runner.tick(); // $80k: row 1
    await runner.tick(); // $80k: row 1 already done
    await runner.tick(); // $50k: row 2
    expect(buy.mock.calls.map((c) => c[0])).toEqual([1n, 2n]);
  });
  it('holds a ranged strategy when the market cap is outside or unknown', async () => {
    const { runner, buy } = setup(
      [
        {
          id: 'd',
          kind: 'DCA',
          intervalSeconds: 60,
          minLamports: 1n,
          maxLamports: 1n,
          marketCapMaxUsd: 50000,
        },
      ],
      { feeds: [[trade('a', 'Buy', '1')]] },
    );
    runner.start();
    await runner.tick();
    await runner.tick();
    expect(buy).not.toHaveBeenCalled();
  });
});
