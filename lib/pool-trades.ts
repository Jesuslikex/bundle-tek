import {
  CANDLE_NETWORKS,
  candleSelection,
  poolObject,
  readPoolJson,
} from './pool-candles';
import { validateTokenSource, type TokenSource } from './token-source';
export type PoolTrade = {
  id: string;
  transaction: string;
  sender: string;
  block: number;
  timestamp: string;
  side: 'Buy' | 'Sell';
  tokenAmount: string;
  quoteAmount: string;
  priceUsd: string;
  volumeUsd: string;
};
export type PoolTrades = TokenSource & {
  pool: string;
  quote: string;
  trades: PoolTrade[];
  returnedCount: number;
  observedAt: string;
  source: 'api.geckoterminal.com';
  executionAllowed: false;
  projectRevision?: number;
};
function decimal(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{1,40}(?:\.\d{1,80})?$/.test(value) ||
    !Number.isFinite(Number(value)) ||
    Number(value) < 0 ||
    Number(value) > 1e30
  )
    throw new Error('Invalid trade decimal.');
  return value;
}
export function decodePoolTrades(
  value: unknown,
  source: TokenSource,
  pool: string,
  quote: string,
): PoolTrades {
  const rows = poolObject(value).data;
  if (!Array.isArray(rows) || rows.length > 300)
    throw new Error('Invalid trade list.');
  const seen = new Set<string>();
  let prior = Infinity;
  const trades = rows.map((row): PoolTrade => {
    const item = poolObject(row),
      a = poolObject(item.attributes);
    const tx = a.tx_hash;
    if (
      typeof tx !== 'string' ||
      !(
        source.chain === 'Solana'
          ? /^[1-9A-HJ-NP-Za-km-z]{64,88}$/
          : /^0x[0-9a-fA-F]{64}$/
      ).test(tx)
    )
      throw new Error('Invalid transaction reference.');
    const sender = validateTokenSource({
      chain: source.chain,
      address: a.tx_from_address,
    }).address;
    const from = validateTokenSource({
      chain: source.chain,
      address: a.from_token_address,
    }).address;
    const to = validateTokenSource({
      chain: source.chain,
      address: a.to_token_address,
    }).address;
    const buy = a.kind === 'buy';
    if (
      item.type !== 'trade' ||
      !['buy', 'sell'].includes(String(a.kind)) ||
      (buy
        ? to !== source.address || from !== quote
        : from !== source.address || to !== quote)
    )
      throw new Error('Trade token context mismatch.');
    const timestamp = a.block_timestamp;
    if (
      typeof timestamp !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp)
    )
      throw new Error('Invalid trade timestamp.');
    const time = Date.parse(timestamp);
    if (
      !Number.isFinite(time) ||
      time < 1577836800000 ||
      time > Date.now() + 60000 ||
      time > prior ||
      !Number.isSafeInteger(a.block_number) ||
      Number(a.block_number) < 0
    )
      throw new Error('Invalid trade block or order.');
    const parts = typeof item.id === 'string' ? item.id.split('_') : [];
    if (
      parts.length !== 5 ||
      parts[0] !== CANDLE_NETWORKS[source.chain] ||
      parts[1] !== String(a.block_number) ||
      parts[2] !== tx ||
      !/^\d{1,10}$/.test(parts[3]) ||
      !/^\d{10,12}$/.test(parts[4]) ||
      seen.has(String(item.id))
    )
      throw new Error('Invalid or duplicate trade identity.');
    seen.add(String(item.id));
    prior = time;
    const tokenAmount = decimal(buy ? a.to_token_amount : a.from_token_amount);
    const quoteAmount = decimal(buy ? a.from_token_amount : a.to_token_amount);
    const priceUsd = decimal(buy ? a.price_to_in_usd : a.price_from_in_usd);
    const volumeUsd = decimal(a.volume_in_usd);
    return {
      id: String(item.id),
      transaction: tx,
      sender,
      block: Number(a.block_number),
      timestamp,
      side: buy ? 'Buy' : 'Sell',
      tokenAmount,
      quoteAmount,
      priceUsd,
      volumeUsd,
    };
  });
  return {
    ...source,
    pool,
    quote,
    trades: trades.slice(0, 100),
    returnedCount: rows.length,
    observedAt: new Date().toISOString(),
    source: 'api.geckoterminal.com',
    executionAllowed: false,
  };
}
export async function observePoolTrades(
  sourceValue: TokenSource,
  poolValue: unknown,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const source = validateTokenSource(sourceValue),
    pool = candleSelection(source.chain, poolValue, '1h').pool;
  const network = CANDLE_NETWORKS[source.chain],
    root = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}`;
  const identity = poolObject(
    poolObject(await readPoolJson(root, signal, fetcher)).data,
  );
  const relationships = poolObject(identity.relationships);
  const base = poolObject(poolObject(relationships.base_token).data),
    quote = poolObject(poolObject(relationships.quote_token).data);
  const normalized = (address: string) =>
    source.chain === 'Solana' ? address : address.toLowerCase();
  if (
    identity.type !== 'pool' ||
    identity.id !== `${network}_${normalized(pool)}` ||
    base.type !== 'token' ||
    base.id !== `${network}_${normalized(source.address)}` ||
    quote.type !== 'token' ||
    typeof quote.id !== 'string' ||
    !quote.id.startsWith(`${network}_`)
  )
    throw new Error('Pool identity mismatch.');
  const quoteAddress = validateTokenSource({
    chain: source.chain,
    address: quote.id.slice(network.length + 1),
  }).address;
  if (quoteAddress === source.address)
    throw new Error('Invalid pool token pair.');
  return decodePoolTrades(
    await readPoolJson(`${root}/trades?token=base`, signal, fetcher, 524288),
    source,
    pool,
    quoteAddress,
  );
}
