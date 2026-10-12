import { validateTokenSource, type TokenSource } from './token-source';
export const CANDLE_NETWORKS: Readonly<Record<string, string>> = {
  Solana: 'solana',
  Ethereum: 'eth',
  Base: 'base',
  BNB: 'bsc',
};
export const CANDLE_INTERVALS = {
  '1m': { timeframe: 'minute', aggregate: 1, seconds: 60 },
  '5m': { timeframe: 'minute', aggregate: 5, seconds: 300 },
  '1h': { timeframe: 'hour', aggregate: 1, seconds: 3600 },
  '1d': { timeframe: 'day', aggregate: 1, seconds: 86400 },
} as const;
export type CandleInterval = keyof typeof CANDLE_INTERVALS;
export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
export type PoolCandles = {
  chain: string;
  address: string;
  pool: string;
  interval: CandleInterval;
  candles: Candle[];
  observedAt: string;
  source: 'api.geckoterminal.com';
  executionAllowed: false;
  projectRevision?: number;
  latestObservedAt?: string;
  olderExhausted?: boolean;
};
export const MAX_SAVED_CANDLES = 500;
export function refreshSavedCandles(
  previous: PoolCandles,
  page: PoolCandles,
): PoolCandles {
  if (
    previous.chain !== page.chain ||
    previous.address !== page.address ||
    previous.pool !== page.pool ||
    previous.interval !== page.interval ||
    !page.candles.length ||
    page.observedAt <= (previous.latestObservedAt ?? previous.observedAt) ||
    (previous.candles.at(-1)?.time ?? 0) > page.candles.at(-1)!.time
  )
    throw new Error(
      'Latest candle page is empty, stale or differs from this selection.',
    );
  const boundary = page.candles[0].time;
  const candles = [
    ...previous.candles.filter((c) => c.time < boundary),
    ...page.candles,
  ].slice(-MAX_SAVED_CANDLES);
  return {
    ...page,
    candles,
    latestObservedAt: page.observedAt,
    olderExhausted: Boolean(
      previous.olderExhausted && previous.candles[0]?.time === candles[0]?.time,
    ),
  };
}
export function appendOlderCandles(previous: PoolCandles, page: PoolCandles) {
  const boundary = previous.candles[0]?.time;
  if (
    previous.chain !== page.chain ||
    previous.address !== page.address ||
    previous.pool !== page.pool ||
    previous.interval !== page.interval ||
    !boundary ||
    previous.olderExhausted ||
    previous.candles.length >= MAX_SAVED_CANDLES ||
    page.candles.some((c) => c.time >= boundary)
  )
    throw new Error('Older candle context or boundary mismatch.');
  return {
    ...page,
    latestObservedAt: previous.latestObservedAt ?? previous.observedAt,
    olderExhausted: page.candles.length === 0,
    candles: [...page.candles, ...previous.candles].slice(-MAX_SAVED_CANDLES),
  };
}
export function candleSelection(
  chain: string,
  pool: unknown,
  interval: unknown,
) {
  if (
    !CANDLE_NETWORKS[chain] ||
    typeof interval !== 'string' ||
    !Object.hasOwn(CANDLE_INTERVALS, interval)
  )
    throw new Error('Unsupported candle network or interval.');
  return {
    pool: validateTokenSource({ chain, address: pool }).address,
    interval: interval as CandleInterval,
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid provider object.');
  return value as Record<string, unknown>;
}
async function readJson(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
  maxBytes = 262144,
): Promise<unknown> {
  const response = await fetcher(url, {
    signal,
    redirect: 'manual',
    cache: 'no-store',
    credentials: 'omit',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Candle provider unavailable.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty candle response.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '',
    length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error('Candle response too large.');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text);
}
export { object as poolObject, readJson as readPoolJson };
export function decodePoolCandles(
  value: unknown,
  source: TokenSource,
  pool: string,
  interval: CandleInterval,
): PoolCandles {
  const document = object(value),
    data = object(document.data),
    meta = object(document.meta);
  const base = validateTokenSource({
    chain: source.chain,
    address: object(meta.base).address,
  }).address;
  if (base !== source.address || data.type !== 'ohlcv_request_response')
    throw new Error('Candle token context mismatch.');
  const rows = object(data.attributes).ohlcv_list;
  if (!Array.isArray(rows) || rows.length > 100)
    throw new Error('Invalid candle list.');
  const seconds = CANDLE_INTERVALS[interval].seconds;
  let prior = Infinity;
  const candles: Candle[] = rows
    .map((row: unknown) => {
      if (
        !Array.isArray(row) ||
        row.length !== 6 ||
        row.some((v) => typeof v !== 'number' || !Number.isFinite(v))
      )
        throw new Error('Invalid candle values.');
      const [time, open, high, low, close, volume] = row as number[];
      if (
        !Number.isSafeInteger(time) ||
        time < 1577836800 ||
        time > Math.floor(Date.now() / 1000) ||
        time % seconds !== 0 ||
        time >= prior ||
        [open, high, low, close].some((v) => v <= 0 || v > 1e18) ||
        volume < 0 ||
        volume > 1e18 ||
        low > Math.min(open, close) ||
        high < Math.max(open, close) ||
        low > high
      )
        throw new Error('Inconsistent candle range or time.');
      prior = time;
      return { time, open, high, low, close, volume };
    })
    .reverse();
  return {
    ...source,
    pool,
    interval,
    candles,
    observedAt: new Date().toISOString(),
    source: 'api.geckoterminal.com',
    executionAllowed: false,
  };
}
export async function observePoolCandles(
  sourceValue: TokenSource,
  poolValue: unknown,
  intervalValue: unknown,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  before?: number,
) {
  if (
    before !== undefined &&
    (!Number.isSafeInteger(before) ||
      before < 1577836800 ||
      before > Date.now() / 1000)
  )
    throw new Error('Invalid candle cursor.');
  const source = validateTokenSource(sourceValue),
    { pool, interval } = candleSelection(
      source.chain,
      poolValue,
      intervalValue,
    ),
    network = CANDLE_NETWORKS[source.chain];
  const root = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}`;
  const identity = object(object(await readJson(root, signal, fetcher)).data);
  const baseToken = object(
    object(object(identity.relationships).base_token).data,
  );
  const id =
    source.chain === 'Solana'
      ? `${network}_${pool}`
      : `${network}_${pool.toLowerCase()}`;
  const baseId =
    source.chain === 'Solana'
      ? `${network}_${source.address}`
      : `${network}_${source.address.toLowerCase()}`;
  if (
    identity.type !== 'pool' ||
    identity.id !== id ||
    baseToken.type !== 'token' ||
    baseToken.id !== baseId
  )
    throw new Error('Pool does not price this base token.');
  const config = CANDLE_INTERVALS[interval];
  const data = await readJson(
    `${root}/ohlcv/${config.timeframe}?aggregate=${config.aggregate}&limit=100&currency=usd&token=base&include_empty_intervals=false${before === undefined ? '' : `&before_timestamp=${before}`}`,
    signal,
    fetcher,
  );
  const result = decodePoolCandles(data, source, pool, interval);
  if (before !== undefined && result.candles.some((c) => c.time >= before))
    throw new Error('Candle provider ignored cursor.');
  return result;
}
