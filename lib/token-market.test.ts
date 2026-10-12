import { expect, it } from 'vitest';
import { decodeTokenMarket, observeTokenMarket } from './token-market';
const address = 'So11111111111111111111111111111111111111112',
  quote = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  pool = '8T3HT8ce1ETykLbWHvDRNi8TgDyaKpBEEYiDoWWiFZCW';
const source = { chain: 'Solana' as const, address };
const row = () => ({
  chainId: 'solana',
  dexId: 'raydium',
  pairAddress: pool,
  baseToken: { address },
  quoteToken: { address: quote, symbol: 'USDC' },
  priceUsd: '0.00000000123456789',
  liquidity: { usd: 100 },
  volume: { h24: 200 },
  priceChange: { h24: -5 },
  marketCap: 1000,
  url: 'https://evil.test',
});
it('keeps exact price strings and pool metrics without trusting provider URLs or inverting quote-only prices', () => {
  const report = decodeTokenMarket(
    [
      row(),
      {
        ...row(),
        pairAddress: quote,
        baseToken: { address: quote },
        quoteToken: { address, symbol: 'SOL' },
      },
    ],
    source,
  );
  expect(report).toMatchObject({
    executionAllowed: false,
    returnedPairCount: 2,
    quoteOnlyPairCount: 1,
    pairs: [
      {
        priceUsd: '0.00000000123456789',
        url: `https://dexscreener.com/solana/${pool}`,
        change24h: -5,
        volume24hUsd: 200,
      },
    ],
  });
  const absent = decodeTokenMarket(
    [
      {
        ...row(),
        priceUsd: null,
        liquidity: null,
        volume: undefined,
        priceChange: null,
        marketCap: null,
      },
    ],
    source,
  );
  expect(absent.pairs[0]).toMatchObject({
    priceUsd: null,
    liquidityUsd: null,
    volume24hUsd: null,
    change24h: null,
    marketCapUsd: null,
  });
  expect(decodeTokenMarket([], source).pairs).toEqual([]);
});
it('rejects mixed networks, unrelated tokens, duplicate pools and malformed numeric data', () => {
  for (const patch of [
    { chainId: 'base' },
    {
      baseToken: { address: quote },
      quoteToken: { address: pool, symbol: 'OTHER' },
    },
    { priceUsd: '1e4' },
    { priceUsd: '0' },
    { liquidity: { usd: -1 } },
    { volume: { h24: Infinity } },
    { quoteToken: { address: quote, symbol: 'bad\n' } },
    { pairAddress: 'bad' },
  ])
    expect(() => decodeTokenMarket([{ ...row(), ...patch }], source)).toThrow();
  expect(() => decodeTokenMarket([row(), row()], source)).toThrow(/Duplicate/);
  expect(() => decodeTokenMarket(Array(101).fill(row()), source)).toThrow(
    /oversized/,
  );
  expect(() =>
    decodeTokenMarket([], { chain: 'Arc', address: '0x' + '1'.repeat(40) }),
  ).toThrow();
});
it('uses a bounded public provider read with no credentials and rejects oversized or failed responses', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url, init) => {
    calls.push({
      url:
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      init,
    });
    return Response.json([row()]);
  }) as typeof fetch;
  expect(
    (await observeTokenMarket(source, AbortSignal.timeout(15000), fetcher))
      .pairs,
  ).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    url: `https://api.dexscreener.com/token-pairs/v1/solana/${address}`,
    init: {
      redirect: 'manual',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    },
  });
  await expect(
    observeTokenMarket(
      source,
      AbortSignal.timeout(15000),
      (async () => new Response('fail', { status: 429 })) as typeof fetch,
    ),
  ).rejects.toThrow(/unavailable/);
  await expect(
    observeTokenMarket(
      source,
      AbortSignal.timeout(15000),
      (async () => new Response(' '.repeat(524289))) as typeof fetch,
    ),
  ).rejects.toThrow(/large/);
});
