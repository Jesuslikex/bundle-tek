import { expect, it } from 'vitest';
import {
  marketUsdMicros,
  reviewMarketTrigger,
  marketGrid,
} from './market-trigger';
import type { SavedTokenMarket } from './token-market';
const time = Date.parse('2026-10-11T00:00:00Z');
const snapshot: SavedTokenMarket = {
  chain: 'Solana',
  address: 'mint',
  source: 'api.dexscreener.com',
  executionAllowed: false,
  projectRevision: 1,
  observedAt: new Date(time).toISOString(),
  returnedPairCount: 1,
  quoteOnlyPairCount: 0,
  pairs: [
    {
      address: 'pool',
      dex: 'test',
      url: 'https://dexscreener.com/solana/pool',
      quoteSymbol: 'SOL',
      priceUsd: '0.1',
      liquidityUsd: null,
      volume24hUsd: null,
      change24h: null,
      marketCapUsd: 4064.000001,
    },
  ],
};
const trigger = {
    pair: 'pool',
    direction: 'at-or-above' as const,
    targetUsd: '4064.000001',
  },
  context = { chain: 'Solana', mint: 'mint', revision: 1 };
it('uses exact microdollar comparisons, equality and both trigger directions', () => {
  expect(reviewMarketTrigger(trigger, snapshot, context, time).met).toBe(true);
  expect(
    reviewMarketTrigger(
      { ...trigger, targetUsd: '4064.000002' },
      snapshot,
      context,
      time,
    ).met,
  ).toBe(false);
  expect(
    reviewMarketTrigger(
      { ...trigger, direction: 'at-or-below' },
      snapshot,
      context,
      time,
    ).met,
  ).toBe(true);
  expect(marketUsdMicros('9007199254.740991')).toBe(9007199254740991n);
});
it('withholds readiness for stale, future, mismatched, missing or ambiguous provider observations', () => {
  for (const [data, ctx, now] of [
    [snapshot, context, time + 30000],
    [snapshot, context, time - 1001],
    [snapshot, { ...context, revision: 2 }, time],
    [{ ...snapshot, pairs: [] }, context, time],
    [
      { ...snapshot, pairs: [...snapshot.pairs, ...snapshot.pairs] },
      context,
      time,
    ],
    [
      { ...snapshot, pairs: [{ ...snapshot.pairs[0], marketCapUsd: null }] },
      context,
      time,
    ],
  ] as const)
    expect(() =>
      reviewMarketTrigger(trigger, data as SavedTokenMarket, ctx, now),
    ).toThrow();
  for (const raw of ['0', '-1', '01', '1e3', '1.0000001', '9007199254.740992'])
    expect(() => marketUsdMicros(raw)).toThrow();
});
it('includes both grid edges, keeps levels distinct and conserves u64-scale input with residue in the final level', () => {
  const levels = marketGrid({
    minimumUsd: '4064',
    maximumUsd: '4877',
    lines: 5,
    totalRaw: '18446744073709551615',
    decimals: 6,
  });
  expect(levels[0].targetUsd).toBe('4064');
  expect(levels.at(-1)!.targetUsd).toBe('4877');
  expect(levels.reduce((sum, row) => sum + BigInt(row.unitsRaw), 0n)).toBe(
    18446744073709551615n,
  );
  expect(new Set(levels.map((row) => row.targetUsd)).size).toBe(5);
  expect(
    marketGrid({
      minimumUsd: '1',
      maximumUsd: '1.000002',
      lines: 3,
      totalRaw: '10',
      decimals: 0,
    }).map((row) => row.unitsRaw),
  ).toEqual(['3', '3', '4']);
});
it('rejects impossible, descending, oversized or zero-unit grids', () => {
  const base = {
    minimumUsd: '1',
    maximumUsd: '2',
    lines: 5,
    totalRaw: '10',
    decimals: 6,
  };
  for (const change of [
    { maximumUsd: '1' },
    { lines: 51 },
    { lines: 1 },
    { totalRaw: '4' },
    { totalRaw: '18446744073709551616' },
    { maximumUsd: '1.000001' },
    { decimals: 256 },
  ])
    expect(() => marketGrid({ ...base, ...change })).toThrow();
});
