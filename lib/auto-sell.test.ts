import { describe, expect, it } from 'vitest';
import {
  applyAutoSellTrade,
  autoSellStrategyError,
  checkAutoSellEnd,
  decimalToRaw,
  durationSeconds,
  initialAutoSellState,
  marketCapInRange,
  newAutoSellStrategy,
  readyToSellRaw,
  type AutoSellStrategy,
} from './auto-sell';

const SUPPLY = 1_000_000_000_000_000n; // 1B tokens, 6 decimals
const OWN = 'Own1111111111111111111111111111111111111111';
const BUYER = 'Buy1111111111111111111111111111111111111111';
const strategy = (patch: Partial<AutoSellStrategy> = {}): AutoSellStrategy => ({
  ...newAutoSellStrategy(0),
  replicationPercent: '50',
  ...patch,
});
const ctx = (patch = {}) => ({
  decimals: 6,
  totalSupplyRaw: SUPPLY,
  ownWallets: new Set([OWN]),
  marketCapUsd: 50_000,
  random: () => 0.5,
  ...patch,
});
const buy = (tokenAmount: string, sender = BUYER, quoteAmount = '1') => ({
  id: `t-${tokenAmount}-${sender}`,
  sender,
  side: 'Buy' as const,
  tokenAmount,
  quoteAmount,
  quoteMint: 'So11111111111111111111111111111111111111112',
  priceUsd: '0.00005',
});

describe('auto sell rules', () => {
  it('requires a replication factor like Proxima', () => {
    expect(autoSellStrategyError(newAutoSellStrategy(0))).toBe(
      'Replication factor is required',
    );
    expect(autoSellStrategyError(strategy())).toBeNull();
    expect(
      autoSellStrategyError(
        strategy({ marketCapMinUsd: '100', marketCapMaxUsd: '50' }),
      ),
    ).toMatch(/below/);
  });

  it('sells the replication share of every outside buy', () => {
    const r = applyAutoSellTrade(
      strategy(),
      initialAutoSellState(0),
      buy('1000'),
      ctx(),
    );
    expect(r.outcome).toBe('buffered');
    expect(r.addedRaw).toBe(500_000_000n);
  });

  it('ignores own wallets, whitelist and sells', () => {
    const s = strategy({ whitelist: [BUYER] });
    expect(
      applyAutoSellTrade(
        strategy(),
        initialAutoSellState(0),
        buy('10', OWN),
        ctx(),
      ).outcome,
    ).toBe('own-wallet');
    expect(
      applyAutoSellTrade(s, initialAutoSellState(0), buy('10'), ctx()).outcome,
    ).toBe('whitelisted');
    expect(
      applyAutoSellTrade(
        strategy(),
        initialAutoSellState(0),
        { ...buy('10'), side: 'Sell' },
        ctx(),
      ).outcome,
    ).toBe('not-a-buy');
  });

  it('applies rate, min SOL and min token triggers', () => {
    const rate = strategy({ trigger: { kind: 'rate', percent: '40' } });
    expect(
      applyAutoSellTrade(
        rate,
        initialAutoSellState(0),
        buy('10'),
        ctx({ random: () => 0.5 }),
      ).outcome,
    ).toBe('rate-skipped');
    expect(
      applyAutoSellTrade(
        rate,
        initialAutoSellState(0),
        buy('10'),
        ctx({ random: () => 0.3 }),
      ).outcome,
    ).toBe('buffered');
    const sol = strategy({ trigger: { kind: 'min-sol', amount: '0.5' } });
    expect(
      applyAutoSellTrade(
        sol,
        initialAutoSellState(0),
        buy('10', BUYER, '0.4'),
        ctx(),
      ).outcome,
    ).toBe('below-trigger');
    expect(
      applyAutoSellTrade(
        sol,
        initialAutoSellState(0),
        buy('10', BUYER, '0.5'),
        ctx(),
      ).outcome,
    ).toBe('buffered');
    const tok = strategy({ trigger: { kind: 'min-token', amount: '100' } });
    expect(
      applyAutoSellTrade(tok, initialAutoSellState(0), buy('99.9'), ctx())
        .outcome,
    ).toBe('below-trigger');
  });

  it('only sells inside the market cap range', () => {
    const s = strategy({ marketCapMinUsd: '10000', marketCapMaxUsd: '100000' });
    expect(marketCapInRange(s, 50_000)).toBe(true);
    expect(marketCapInRange(s, 5_000)).toBe(false);
    expect(marketCapInRange(s, 200_000)).toBe(false);
    expect(marketCapInRange(s, null)).toBe(false);
    expect(marketCapInRange(strategy(), null)).toBe(true);
    expect(
      applyAutoSellTrade(
        s,
        initialAutoSellState(0),
        buy('10'),
        ctx({ marketCapUsd: 5_000 }),
      ).outcome,
    ).toBe('out-of-range');
  });

  it('buffers until the minimum % supply per sell', () => {
    const s = strategy({ minSupplyPercentPerSell: '0.1' }); // 1M tokens
    let state = applyAutoSellTrade(
      s,
      initialAutoSellState(0),
      buy('1000000'),
      ctx(),
    ).state;
    expect(readyToSellRaw(s, state, SUPPLY)).toBe(0n);
    state = applyAutoSellTrade(
      s,
      state,
      buy('1000000', 'Buy2111111111111111111111111111111111111111'),
      ctx(),
    ).state;
    expect(readyToSellRaw(s, state, SUPPLY)).toBe(1_000_000_000_000n);
  });

  it('caps queued sells at the Max Amount and ends only this strategy', () => {
    const s = strategy({ endMaxSupplyPercent: '1', replicationPercent: '100' }); // 10M tokens
    let state = applyAutoSellTrade(
      s,
      initialAutoSellState(0),
      buy('25000000'),
      ctx(),
    ).state;
    expect(state.bufferedRaw).toBe(10_000_000_000_000n);
    state = { ...state, bufferedRaw: 0n, soldRaw: 10_000_000_000_000n };
    expect(checkAutoSellEnd(s, state, 1, SUPPLY)).toMatchObject({
      status: 'ended',
      endedReason: 'Max amount sold',
    });
    const other = strategy();
    expect(
      checkAutoSellEnd(other, initialAutoSellState(0), 1, SUPPLY).status,
    ).toBe('running');
  });

  it('ends after the duration', () => {
    const s = strategy({ endDurationSeconds: durationSeconds('0', '1', '30') });
    expect(s.endDurationSeconds).toBe(90);
    expect(
      checkAutoSellEnd(s, initialAutoSellState(0), 89_999, SUPPLY).status,
    ).toBe('running');
    expect(
      checkAutoSellEnd(s, initialAutoSellState(0), 90_000, SUPPLY).endedReason,
    ).toBe('Duration reached');
  });

  it('parses decimals exactly', () => {
    expect(decimalToRaw('1.2345678', 6)).toBe(1_234_567n);
    expect(decimalToRaw('7', 0)).toBe(7n);
  });
});
