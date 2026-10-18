import { decodeTokenMarket, type TokenMarket } from './token-market';
import { validateTokenSource, type TokenSource } from './token-source';

import { exactMarketCap } from './strategy-exact-usd';
export type ExactStrategyMarket = {
  market: TokenMarket;
  caps: Record<string, string | null>;
};
export function decodeExactStrategyMarket(
  text: string,
  source: TokenSource,
): ExactStrategyMarket {
  const numbers = new WeakMap<object, string>();
  const raw: unknown = JSON.parse(
    text,
    function (
      this: object,
      key: string,
      value: unknown,
      context?: { source?: string },
    ) {
      if (key === 'marketCap' && typeof value === 'number') {
        if (typeof context?.source !== 'string')
          throw Error(
            'Exact JSON number capture is unavailable in this runtime.',
          );
        numbers.set(this, context.source);
      }
      return value;
    },
  );
  const market = decodeTokenMarket(raw, source),
    caps: Record<string, string | null> = {};
  for (const pair of market.pairs) {
    const row = (raw as { pairAddress: string; marketCap?: unknown }[]).find(
      (r) => r.pairAddress === pair.address,
    )!;
    const literal = numbers.get(row);
    if (pair.marketCapUsd === null || pair.marketCapUsd === 0)
      caps[pair.address] = null;
    else {
      if (literal === undefined)
        throw Error('Market cap lacks its source number.');
      const exact = exactMarketCap(literal).text;
      if (Number(exact) !== pair.marketCapUsd)
        throw Error('Market cap source differs from its decoded pool.');
      caps[pair.address] = exact;
    }
  }
  return { market, caps };
}
/** One fixed-host, bounded public provider read. No RPC, keys, retry or financial request. */
export async function observeExactStrategyMarket(
  mint: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const source = validateTokenSource({ chain: 'Solana', address: mint });
  const response = await fetcher(
    `https://api.dexscreener.com/token-pairs/v1/solana/${source.address}`,
    {
      signal,
      cache: 'no-store',
      redirect: 'manual',
      headers: { accept: 'application/json' },
    },
  );
  if (!response.ok) throw Error('Market provider unavailable.');
  const reader = response.body?.getReader();
  if (!reader) throw Error('Empty market response.');
  let text = '',
    length = 0;
  const decoder = new TextDecoder();
  let complete = false;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > 524288) throw Error('Market response is too large.');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    complete = true;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
  return decodeExactStrategyMarket(text, source);
}
