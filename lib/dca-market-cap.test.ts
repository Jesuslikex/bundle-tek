import { expect, it } from 'vitest';
import { dcaMarketCapRange, reviewDcaMarketCap } from './dca-market-cap';
import type { SavedTokenMarket } from './token-market';
const pair = '11111111111111111111111111111111';
const mint = 'So11111111111111111111111111111111111111112';
const now = Date.parse('2026-10-13T12:00:00.000Z');
const context = { chain: 'Solana', mint, revision: 1 };
const observation = (cap: number | null = 100): SavedTokenMarket => ({
  chain: 'Solana',
  address: mint,
  projectRevision: 1,
  source: 'api.dexscreener.com',
  executionAllowed: false,
  observedAt: new Date(now).toISOString(),
  returnedPairCount: 1,
  quoteOnlyPairCount: 0,
  pairs: [
    {
      address: pair,
      dex: 'raydium',
      url: 'https://dexscreener.com/solana/' + pair,
      quoteSymbol: 'SOL',
      priceUsd: '1',
      liquidityUsd: 100,
      volume24hUsd: 100,
      change24h: 0,
      marketCapUsd: cap,
    },
  ],
});
it('canonicalizes exact bounds with a zero floor, optional ceiling and inclusive endpoints', () => {
  expect(dcaMarketCapRange({ pair, minimumUsd: '0.000000' })).toEqual({
    pair,
    minimumUsd: '0',
  });
  const range = dcaMarketCapRange({
    pair,
    minimumUsd: '100.000000',
    maximumUsd: '200.00',
  });
  expect(range).toEqual({ pair, minimumUsd: '100', maximumUsd: '200' });
  for (const cap of [100, 200])
    expect(reviewDcaMarketCap(range, observation(cap), context, now).met).toBe(
      true,
    );
  for (const cap of [99.999999, 200.000001])
    expect(reviewDcaMarketCap(range, observation(cap), context, now).met).toBe(
      false,
    );
  expect(
    reviewDcaMarketCap(
      { pair, minimumUsd: '0' },
      observation(9007199254),
      context,
      now,
    ).met,
  ).toBe(true);
});
it('rejects malformed, reversed, excessive-precision and inexact USD bounds', () => {
  for (const bad of [
    null,
    {},
    { pair: 'bad', minimumUsd: '0' },
    { pair, minimumUsd: '-1' },
    { pair, minimumUsd: '1e2' },
    { pair, minimumUsd: '1.0000001' },
    { pair, minimumUsd: '10', maximumUsd: '9' },
    { pair, minimumUsd: '0', maximumUsd: '0' },
    { pair, minimumUsd: '9007199254.740992' },
    { pair, minimumUsd: '0', other: true },
  ])
    expect(() => dcaMarketCapRange(bad)).toThrow();
});
it('requires fresh, unambiguous pool coverage and exact project provenance', () => {
  const range = { pair, minimumUsd: '0' };
  for (const o of [
    observation(null),
    observation(0),
    { ...observation(), projectRevision: 2 },
    { ...observation(), address: pair },
    { ...observation(), pairs: [] },
    {
      ...observation(),
      pairs: [...observation().pairs, ...observation().pairs],
    },
    { ...observation(), observedAt: new Date(now - 30000).toISOString() },
    { ...observation(), observedAt: new Date(now + 1001).toISOString() },
  ])
    expect(() => reviewDcaMarketCap(range, o, context, now)).toThrow();
  expect(
    reviewDcaMarketCap(
      range,
      { ...observation(), observedAt: new Date(now - 29999).toISOString() },
      context,
      now,
    ).met,
  ).toBe(true);
});
