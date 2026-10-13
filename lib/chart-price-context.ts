import {
  candleCurrency,
  SOL_CANDLE_QUOTE,
  type PoolCandles,
} from './pool-candles';
export function chartPriceContext(snapshot: PoolCandles, projectId = '') {
  const currency = candleCurrency(snapshot.currency ?? 'usd', snapshot.chain);
  if (
    currency === 'sol' &&
    (snapshot.quoteMint !== SOL_CANDLE_QUOTE ||
      snapshot.address === SOL_CANDLE_QUOTE)
  )
    throw new Error('Chart quote denomination differs.');
  const legacy = `${projectId}:${snapshot.chain}:${snapshot.address}:${snapshot.pool}:${snapshot.interval}`;
  return currency === 'sol' ? legacy + ':sol' : legacy;
}
