import { describe, expect, it, vi } from 'vitest';
import {
  MARKET_CLEANUP_BUYER_RESERVE_LAMPORTS,
  groupSupplyBps,
  nextBuyer,
  nextSeller,
  roundDelay,
  sellAmount,
  validMarketCleanupConfig,
  type MarketCleanupBalance,
  type MarketCleanupConfig,
} from './market-cleanup';
import {
  startMarketCleanup,
  type MarketCleanupSnapshot,
} from './market-cleanup-runner';
import type { CleanupSide } from './market-cleanup-execute';

const base: MarketCleanupConfig = {
  sellers: ['s1', 's2'],
  buyers: ['b1', 'b2'],
  sellMinBps: 5000,
  sellMaxBps: 5000,
  delay: { kind: 'fixed', ms: 500 },
  maxRounds: 10,
  maxBuyLamports: null,
};
const map = (rows: MarketCleanupBalance[]) =>
  new Map(rows.map((r) => [r.wallet, r]));

describe('market cleanup planning', () => {
  it('validates wallets, shares, delays and rounds', () => {
    expect(validMarketCleanupConfig(base)).toBe(base);
    for (const [patch, message] of [
      [{ sellers: [] }, /seller/],
      [{ buyers: ['s1'] }, /both/],
      [{ sellMinBps: 0 }, /0.01%/],
      [{ sellMinBps: 6000 }, /0.01%/],
      [{ delay: { kind: 'fixed', ms: 499 } }, /0.5s/],
      [{ delay: { kind: 'random', minMs: 2000, maxMs: 1000 } }, /0.5s/],
      [{ delay: { kind: 'fixed', ms: 300_001 } }, /300s/],
      [{ maxRounds: 0 }, /rounds/],
      [{ maxBuyLamports: 0n }, /cap/],
    ] as const)
      expect(() =>
        validMarketCleanupConfig({ ...base, ...patch } as MarketCleanupConfig),
      ).toThrow(message);
  });
  it('rotates sellers with tokens and buyers that can pay plus their reserve', () => {
    const balances = map([
      { wallet: 's1', tokenRaw: 0n, lamports: 0n },
      { wallet: 's2', tokenRaw: 5n, lamports: 0n },
      { wallet: 'b1', tokenRaw: 0n, lamports: 100n },
      {
        wallet: 'b2',
        tokenRaw: 0n,
        lamports: 100n + MARKET_CLEANUP_BUYER_RESERVE_LAMPORTS,
      },
    ]);
    expect(nextSeller(['s1', 's2'], balances, -1)).toBe(1);
    expect(nextSeller(['s1'], balances, -1)).toBe(-1);
    expect(nextBuyer(['b1', 'b2'], balances, -1, 100n)).toBe(1);
    expect(nextBuyer(['b1', 'b2'], balances, -1, 101n)).toBe(-1);
  });
  it('sells a share of the balance, never zero, and picks delays in range', () => {
    expect(
      sellAmount(1000n, { sellMinBps: 2500, sellMaxBps: 2500 }, () => 0),
    ).toBe(250n);
    expect(sellAmount(1n, { sellMinBps: 1, sellMaxBps: 1 }, () => 0)).toBe(1n);
    expect(
      sellAmount(1000n, { sellMinBps: 1000, sellMaxBps: 2000 }, () => 0.9999),
    ).toBe(200n);
    expect(
      roundDelay({ kind: 'random', minMs: 500, maxMs: 1500 }, () => 0.9999),
    ).toBe(1500);
    expect(
      groupSupplyBps(
        ['s2'],
        map([{ wallet: 's2', tokenRaw: 25n, lamports: 0n }]),
        100n,
      ),
    ).toBe(2500);
  });
});

function harness(options: {
  config?: Partial<MarketCleanupConfig>;
  tokens: Record<string, bigint>;
  lamports: Record<string, bigint>;
  failSell?: boolean;
  uncertainBuy?: boolean;
}) {
  const tokens = { ...options.tokens },
    lamports = { ...options.lamports };
  const trades: [string, CleanupSide, bigint][] = [];
  const snapshots: MarketCleanupSnapshot[] = [];
  let n = 0;
  const runner = startMarketCleanup({
    config: { ...base, ...options.config },
    readBalances: async (wallets) =>
      wallets.map((wallet) => ({
        wallet,
        tokenRaw: tokens[wallet] ?? 0n,
        lamports: lamports[wallet] ?? 0n,
      })),
    trade: async (wallet, side, amountRaw) => {
      trades.push([wallet, side, amountRaw]);
      if (side === 'Buy' && options.uncertainBuy)
        throw Object.assign(new Error('Submission unknown.'), {
          uncertain: true,
          signature: 'sig-unknown',
        });
      n++;
      return {
        intentId: 'i' + n,
        signature: 'sig' + n,
        wallet,
        side,
        inputRaw: amountRaw.toString(),
      };
    },
    awaitFinal: async (sent) => {
      const amount = BigInt(sent.inputRaw);
      if (sent.side === 'Sell') {
        if (options.failSell)
          return {
            state: 'failed',
            signature: sent.signature,
            nativeChangeRaw: null,
            tokenUnitsRaw: null,
          };
        tokens[sent.wallet] -= amount;
        lamports[sent.wallet] = (lamports[sent.wallet] ?? 0n) + amount * 10n;
        return {
          state: 'finalized',
          signature: sent.signature,
          nativeChangeRaw: amount * 10n,
          tokenUnitsRaw: amount,
        };
      }
      lamports[sent.wallet] -= amount;
      tokens[sent.wallet] = (tokens[sent.wallet] ?? 0n) + amount / 10n;
      return {
        state: 'finalized',
        signature: sent.signature,
        nativeChangeRaw: -amount,
        tokenUnitsRaw: amount / 10n,
      };
    },
    sleep: vi.fn(async () => {}),
    onUpdate: (s) => snapshots.push(s),
    random: () => 0,
  });
  return { runner, trades, snapshots, tokens, lamports };
}
const rich = 10_000_000_000n;

describe('market cleanup runner', () => {
  it('moves supply from sellers to buyers, buying with each sale’s actual proceeds', async () => {
    const h = harness({
      config: { sellMinBps: 10_000, sellMaxBps: 10_000 },
      tokens: { s1: 100n, s2: 50n },
      lamports: { b1: rich, b2: rich },
    });
    await h.runner.done;
    expect(h.trades).toEqual([
      ['s1', 'Sell', 100n],
      ['b1', 'Buy', 1000n],
      ['s2', 'Sell', 50n],
      ['b2', 'Buy', 500n],
    ]);
    const last = h.snapshots.at(-1)!;
    expect(last).toMatchObject({
      running: false,
      end: 'sellers-empty',
      soldRaw: 150n,
      boughtRaw: 150n,
      spentLamports: 1500n,
      receivedLamports: 1500n,
    });
    expect(h.tokens).toMatchObject({ s1: 0n, s2: 0n, b1: 100n, b2: 50n });
  });
  it('honours the round limit and the SOL cap for buys', async () => {
    const rounds = harness({
      config: { maxRounds: 1 },
      tokens: { s1: 100n },
      lamports: { b1: rich },
    });
    await rounds.runner.done;
    expect(rounds.snapshots.at(-1)!.end).toBe('max-rounds');
    expect(rounds.trades).toHaveLength(2);
    const capped = harness({
      config: { maxBuyLamports: 300n },
      tokens: { s1: 100n },
      lamports: { b1: rich },
    });
    await capped.runner.done;
    expect(capped.trades[1]).toEqual(['b1', 'Buy', 300n]);
    expect(capped.snapshots.at(-1)!.end).toBe('buy-cap');
  });
  it('stops when no buyer can pay, and never buys after a failed sell', async () => {
    const poor = harness({ tokens: { s1: 100n }, lamports: { b1: 1n } });
    await poor.runner.done;
    expect(poor.snapshots.at(-1)!.end).toBe('no-buyer');
    expect(poor.trades.map((t) => t[1])).toEqual(['Sell']);
    const failing = harness({
      failSell: true,
      tokens: { s1: 100n },
      lamports: { b1: rich },
    });
    await failing.runner.done;
    expect(failing.trades.every((t) => t[1] === 'Sell')).toBe(true);
    expect(failing.snapshots.at(-1)!.end).toBe('failed');
  });
  it('stops on an unknown outcome and never resends it', async () => {
    const h = harness({
      uncertainBuy: true,
      tokens: { s1: 100n },
      lamports: { b1: rich, b2: rich },
    });
    await h.runner.done;
    expect(h.trades.filter((t) => t[1] === 'Buy')).toHaveLength(1);
    expect(h.snapshots.at(-1)).toMatchObject({
      end: 'uncertain',
      uncertainSignature: 'sig-unknown',
    });
  });
  it('stops cleanly and reports a sent trade still waiting to finalize', async () => {
    let release!: () => void;
    const snapshots: MarketCleanupSnapshot[] = [];
    const runner = startMarketCleanup({
      config: base,
      readBalances: async (w) =>
        w.map((wallet) => ({ wallet, tokenRaw: 100n, lamports: rich })),
      trade: async (wallet, side, amountRaw) => ({
        intentId: 'i1',
        signature: 'sig-pending',
        wallet,
        side,
        inputRaw: amountRaw.toString(),
      }),
      awaitFinal: (_sent, signal) =>
        new Promise((_, reject) => {
          release = () => reject(new Error('stopped'));
          signal.addEventListener('abort', () => release());
        }),
      sleep: async () => {},
      onUpdate: (s) => snapshots.push(s),
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    runner.stop();
    await runner.done;
    expect(snapshots.at(-1)).toMatchObject({
      end: 'stopped',
      uncertainSignature: 'sig-pending',
    });
  });
});
