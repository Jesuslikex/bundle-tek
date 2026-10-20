import { poolObject, readPoolJson } from './pool-candles';
import { observePoolTrades } from './pool-trades';
import type { AutoSellObservedTrade } from './auto-sell';

// Browser-side trade feed for Auto Sell. Reads the public GeckoTerminal API
// directly so polling does not spend the account's 15-second server read
// gates, which the sells themselves need.

/** Highest-volume pool for a Solana token, as GeckoTerminal lists it. */
export async function topSolanaPool(
  mint: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const document = poolObject(
    await readPoolJson(
      `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`,
      signal,
      fetcher,
    ),
  );
  const rows = Array.isArray(document.data) ? document.data : [];
  for (const row of rows) {
    const item = poolObject(row);
    const id = typeof item.id === 'string' ? item.id : '';
    if (item.type === 'pool' && id.startsWith('solana_'))
      return id.slice('solana_'.length);
  }
  throw new Error('No trading pool found for this token yet.');
}

export function createAutoSellFeed(
  mint: string,
  fetcher: typeof fetch = fetch,
) {
  let pool: string | null = null;
  return async function readTrades(
    signal: AbortSignal,
  ): Promise<AutoSellObservedTrade[]> {
    pool ??= await topSolanaPool(mint, signal, fetcher);
    const observed = await observePoolTrades(
      { chain: 'Solana', address: mint },
      pool,
      signal,
      fetcher,
    );
    return observed.trades.map((t) => ({
      id: t.id,
      sender: t.sender,
      side: t.side,
      tokenAmount: t.tokenAmount,
      quoteAmount: t.quoteAmount,
      quoteMint: observed.quote,
      priceUsd: t.priceUsd,
      timestamp: t.timestamp,
    }));
  };
}
