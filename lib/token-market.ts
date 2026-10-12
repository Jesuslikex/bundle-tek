import { validateTokenSource, type TokenSource } from './token-source';
export const MARKET_CHAINS: Readonly<Record<string, string>> = {
  Solana: 'solana',
  Ethereum: 'ethereum',
  Base: 'base',
  BNB: 'bsc',
};
export type MarketPair = {
  address: string;
  dex: string;
  url: string;
  quoteSymbol: string;
  priceUsd: string | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  change24h: number | null;
  marketCapUsd: number | null;
};
export type TokenMarket = {
  chain: string;
  address: string;
  observedAt: string;
  source: 'api.dexscreener.com';
  pairs: MarketPair[];
  returnedPairCount: number;
  quoteOnlyPairCount: number;
  executionAllowed: false;
};
export type SavedTokenMarket = TokenMarket & { projectRevision: number };
function metric(value: unknown, signed = false) {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) > 1e18 ||
    (!signed && value < 0)
  )
    throw new Error('Invalid market metric.');
  return value;
}
export function decodeTokenMarket(
  value: unknown,
  source: TokenSource,
): TokenMarket {
  const network = MARKET_CHAINS[source.chain];
  if (!network || !Array.isArray(value) || value.length > 100)
    throw new Error('Unsupported or oversized market response.');
  const same = (a: string, b: string) =>
    source.chain === 'Solana' ? a === b : a.toLowerCase() === b.toLowerCase();
  const seen = new Set<string>();
  let quoteOnlyPairCount = 0;
  const pairs: MarketPair[] = [];
  for (const row of value) {
    if (
      !row ||
      row.chainId !== network ||
      typeof row.dexId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(row.dexId)
    )
      throw new Error('Market network mismatch.');
    const base = validateTokenSource({
      chain: source.chain,
      address: row.baseToken?.address,
    }).address;
    const quote = validateTokenSource({
      chain: source.chain,
      address: row.quoteToken?.address,
    }).address;
    const address = validateTokenSource({
      chain: source.chain,
      address: row.pairAddress,
    }).address;
    const key = source.chain === 'Solana' ? address : address.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate market pair.');
    seen.add(key);
    if (!same(base, source.address) && !same(quote, source.address))
      throw new Error('Unrelated market token.');
    if (!same(base, source.address)) {
      quoteOnlyPairCount++;
      continue;
    }
    if (
      typeof row.quoteToken?.symbol !== 'string' ||
      row.quoteToken.symbol.length > 64 ||
      Array.from(row.quoteToken.symbol as string).some(
        (c) =>
          c.charCodeAt(0) < 32 ||
          (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159),
      )
    )
      throw new Error('Invalid quote token symbol.');
    const price = row.priceUsd ?? null;
    if (
      price !== null &&
      (typeof price !== 'string' ||
        price.length > 100 ||
        !/^(0|[1-9]\d{0,29})(\.\d{1,60})?$/.test(price) ||
        !(Number(price) > 0) ||
        !Number.isFinite(Number(price)))
    )
      throw new Error('Invalid market price.');
    pairs.push({
      address,
      dex: row.dexId,
      url: `https://dexscreener.com/${network}/${address}`,
      quoteSymbol: row.quoteToken.symbol,
      priceUsd: price,
      liquidityUsd: metric(row.liquidity?.usd),
      volume24hUsd: metric(row.volume?.h24),
      change24h: metric(row.priceChange?.h24, true),
      marketCapUsd: metric(row.marketCap),
    });
  }
  pairs.sort(
    (a, b) =>
      (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1) ||
      a.address.localeCompare(b.address),
  );
  return {
    chain: source.chain,
    address: source.address,
    observedAt: new Date().toISOString(),
    source: 'api.dexscreener.com',
    pairs: pairs.slice(0, 20),
    returnedPairCount: value.length,
    quoteOnlyPairCount,
    executionAllowed: false,
  };
}
export async function observeTokenMarket(
  sourceValue: TokenSource,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const source = validateTokenSource(sourceValue),
    network = MARKET_CHAINS[source.chain];
  if (!network)
    throw new Error('Market provider does not support this network.');
  const response = await fetcher(
    `https://api.dexscreener.com/token-pairs/v1/${network}/${source.address}`,
    {
      signal,
      redirect: 'manual',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    },
  );
  if (!response.ok) throw new Error('Market provider unavailable.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty market response.');
  let text = '',
    length = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 524288) {
        await reader.cancel();
        throw new Error('Market response too large.');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return decodeTokenMarket(JSON.parse(text), source);
}
