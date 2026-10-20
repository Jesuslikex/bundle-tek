import { expect, it, vi } from 'vitest';
import { createAutoSellFeed } from './auto-sell-feed';
import { AUTO_SELL_SOL_QUOTE } from './auto-sell-quote-trigger';
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const pool = '11111111111111111111111111111111';
it.each([AUTO_SELL_SOL_QUOTE, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'])(
  'retains the verified quote mint %s through the real pool decoder',
  async (quote) => {
    const time = Math.floor(Date.now() / 1000) - 60,
      signature = '2'.repeat(88);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith(`/tokens/${mint}/pools?page=1`))
        return Response.json({
          data: [{ type: 'pool', id: `solana_${pool}` }],
        });
      if (url.endsWith(`/pools/${pool}`))
        return Response.json({
          data: {
            type: 'pool',
            id: `solana_${pool}`,
            relationships: {
              base_token: { data: { type: 'token', id: `solana_${mint}` } },
              quote_token: { data: { type: 'token', id: `solana_${quote}` } },
            },
          },
        });
      if (url.endsWith(`/pools/${pool}/trades?token=base`))
        return Response.json({
          data: [
            {
              type: 'trade',
              id: `solana_123_${signature}_0_${time}`,
              attributes: {
                block_number: 123,
                block_timestamp: new Date(time * 1000).toISOString(),
                tx_hash: signature,
                tx_from_address: pool,
                kind: 'buy',
                from_token_address: quote,
                to_token_address: mint,
                from_token_amount: '0.5',
                to_token_amount: '10',
                price_to_in_usd: '1',
                volume_in_usd: '10',
              },
            },
          ],
        });
      throw Error('Unexpected fixture request');
    });
    const read = createAutoSellFeed(mint, fetcher);
    const observed = await read(new AbortController().signal);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      quoteMint: quote,
      quoteAmount: '0.5',
      tokenAmount: '10',
      side: 'Buy',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  },
);
