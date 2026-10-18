import { expect, it, vi } from 'vitest';
import {
  decodeExactStrategyMarket,
  observeExactStrategyMarket,
} from './strategy-market-exact';
import { exactMarketCap, compareExactMarketCap } from './strategy-exact-usd';
import {
  strategyContext,
  strategyWallet,
  strategySecond,
} from '../test/strategy-session-fixture';
import { strategyMarketText as marketText } from '../test/strategy-check-fixture';
const source = {
  chain: 'Solana' as const,
  address: strategyContext().token.address,
};
it('retains micro-dollar distinctions already lost by ordinary JSON Number parsing', () => {
  const body = marketText();
  expect((JSON.parse(body) as { marketCap: number }[])[0].marketCap).toBe(
    1000000000000,
  );
  const decoded = decodeExactStrategyMarket(body, source);
  expect(decoded.caps[strategyWallet]).toBe('1000000000000.000001');
  expect(
    compareExactMarketCap(decoded.caps[strategyWallet]!, 1000000000000000000n),
  ).toBe(1);
  expect(
    compareExactMarketCap('999999999999.999999', 1000000000000000000n),
  ).toBe(-1);
});
it.each([
  ['1.23456789e6', '1234567.89'],
  ['1e-12', '0.000000000001'],
  ['0.0000', '0'],
  ['1e18', '1000000000000000000'],
])('normalizes exact %s without binary rounding', (input, expected) => {
  expect(exactMarketCap(input).text).toBe(expected);
});
it.each([
  '-1',
  '01',
  'NaN',
  'Infinity',
  '1e101',
  '1e-101',
  '1000000000000000000.000001',
  '1'.repeat(161),
])('rejects unsupported exact value %s', (v) =>
  expect(() => exactMarketCap(v)).toThrow(),
);
it('does not substitute FDV or quote-token appearances for missing base-token market cap', () => {
  const row = JSON.parse(marketText()) as Record<string, unknown>[];
  row[0].marketCap = null;
  row[0].fdv = 1000000;
  const decoded = decodeExactStrategyMarket(JSON.stringify(row), source);
  expect(decoded.caps[strategyWallet]).toBeNull();
  row[0].baseToken = { address: strategySecond };
  row[0].quoteToken = { address: source.address, symbol: 'USDC' };
  expect(
    decodeExactStrategyMarket(JSON.stringify(row), source).market,
  ).toMatchObject({ pairs: [], quoteOnlyPairCount: 1 });
});
it('uses one fixed-host bounded read and refuses redirect, invalid network and oversized body', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(marketText()));
  await observeExactStrategyMarket(
    source.address,
    new AbortController().signal,
    fetcher,
  );
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    `https://api.dexscreener.com/token-pairs/v1/solana/${source.address}`,
    expect.objectContaining({ redirect: 'manual', cache: 'no-store' }),
  );
  fetcher.mockResolvedValue(new Response('', { status: 302 }));
  await expect(
    observeExactStrategyMarket(
      source.address,
      new AbortController().signal,
      fetcher,
    ),
  ).rejects.toThrow('unavailable');
  fetcher.mockResolvedValue(new Response(' '.repeat(524289)));
  await expect(
    observeExactStrategyMarket(
      source.address,
      new AbortController().signal,
      fetcher,
    ),
  ).rejects.toThrow('large');
  expect(() =>
    decodeExactStrategyMarket(
      marketText().replace('"solana"', '"base"'),
      source,
    ),
  ).toThrow('network');
});
