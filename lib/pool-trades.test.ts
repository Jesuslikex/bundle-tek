import { expect, it, vi } from 'vitest';
import { decodePoolTrades, observePoolTrades } from './pool-trades';
const source = {
    chain: 'Solana' as const,
    address: 'So11111111111111111111111111111111111111112',
  },
  pool = '11111111111111111111111111111111',
  quote = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const time = Math.floor(Date.now() / 1000) - 60,
  tx = '2'.repeat(88);
const trade = (position = 0, side = 'buy') => ({
  id: `solana_123_${tx}_${position}_${time}`,
  type: 'trade',
  attributes: {
    block_number: 123,
    block_timestamp: new Date(time * 1000).toISOString(),
    tx_hash: tx,
    tx_from_address: quote,
    kind: side,
    from_token_address: side === 'buy' ? quote : source.address,
    to_token_address: side === 'buy' ? source.address : quote,
    from_token_amount: '0.123456789123456789',
    to_token_amount: '9007199254740993.123456',
    price_from_in_usd: '1.23456789',
    price_to_in_usd: '0.000000000001',
    volume_in_usd: '2.123456789123456789',
  },
});
it('preserves exact decimals and distinct events in the same transaction, with a bounded retained tape', () => {
  const result = decodePoolTrades(
    { data: [trade(), trade(1, 'sell')] },
    source,
    pool,
    quote,
  );
  expect(result.trades[0].tokenAmount).toBe('9007199254740993.123456');
  expect(result.trades[1].tokenAmount).toBe('0.123456789123456789');
  expect(result.trades[1].side).toBe('Sell');
  expect(result.executionAllowed).toBe(false);
  // Provider identifiers can carry an index time distinct from block time.
  expect(
    decodePoolTrades(
      { data: [{ ...trade(), id: `solana_123_${tx}_0_${time + 4}` }] },
      source,
      pool,
      quote,
    ).trades[0].timestamp,
  ).toBe(trade().attributes.block_timestamp);
  const many = decodePoolTrades(
    { data: Array.from({ length: 300 }, (_, i) => trade(i)) },
    source,
    pool,
    quote,
  );
  expect(many.trades).toHaveLength(100);
  expect(many.returnedCount).toBe(300);
});
it('refuses duplicate events, wrong token directions, identity mismatch, invalid timestamps and malformed decimals', () => {
  expect(() =>
    decodePoolTrades({ data: [trade(), trade()] }, source, pool, quote),
  ).toThrow();
  for (const patch of [
    { kind: 'unknown' },
    { to_token_address: quote },
    { tx_hash: 'bad' },
    { block_number: -1 },
    { block_timestamp: 'bad' },
    { volume_in_usd: '-1' },
    { to_token_amount: '1e4' },
  ]) {
    const row = trade();
    expect(() =>
      decodePoolTrades(
        { data: [{ ...row, attributes: { ...row.attributes, ...patch } }] },
        source,
        pool,
        quote,
      ),
    ).toThrow();
  }
  expect(() =>
    decodePoolTrades(
      { data: [{ ...trade(), id: 'other' }] },
      source,
      pool,
      quote,
    ),
  ).toThrow();
  expect(() =>
    decodePoolTrades({ data: Array(301).fill(trade()) }, source, pool, quote),
  ).toThrow();
});
it('pins provider reads to verified pool base and quote tokens and limits the streamed response', async () => {
  const identity = {
    data: {
      type: 'pool',
      id: 'solana_' + pool,
      relationships: {
        base_token: { data: { type: 'token', id: 'solana_' + source.address } },
        quote_token: { data: { type: 'token', id: 'solana_' + quote } },
      },
    },
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(identity))
    .mockResolvedValueOnce(Response.json({ data: [trade()] }));
  await observePoolTrades(source, pool, AbortSignal.timeout(1000), fetcher);
  expect(fetcher.mock.calls[1][0]).toBe(
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/trades?token=base`,
  );
  expect(fetcher.mock.calls[1][1]).toMatchObject({
    credentials: 'omit',
    redirect: 'manual',
  });
  const wrong = vi
    .fn()
    .mockResolvedValue(
      Response.json({ data: { ...identity.data, id: 'wrong' } }),
    );
  await expect(
    observePoolTrades(source, pool, AbortSignal.timeout(1000), wrong),
  ).rejects.toThrow();
  expect(wrong).toHaveBeenCalledTimes(1);
  const large = vi
    .fn()
    .mockResolvedValueOnce(Response.json(identity))
    .mockResolvedValueOnce(new Response(' '.repeat(524289)));
  await expect(
    observePoolTrades(source, pool, AbortSignal.timeout(1000), large),
  ).rejects.toThrow('too large');
});
