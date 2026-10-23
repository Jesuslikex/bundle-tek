import { AUTO_SELL_MARKET_MAX_AGE_MS } from './auto-sell-market-observation';

// Counter triggers use the existing source-age ceiling, independently of
// whether a strategy has a market-cap range. Arrival time never renews it.
export const AUTO_SELL_COUNTER_MAX_AGE_MS = AUTO_SELL_MARKET_MAX_AGE_MS;

export function autoSellCounterEventTime(
  timestamp: unknown,
  now: number,
  notBefore: number,
) {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(notBefore) ||
    notBefore < 0 ||
    notBefore > now ||
    typeof timestamp !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp)
  )
    return null;
  const at = Date.parse(timestamp);
  if (
    !Number.isSafeInteger(at) ||
    at < notBefore ||
    at > now ||
    now - at > AUTO_SELL_COUNTER_MAX_AGE_MS
  )
    return null;
  const canonical = timestamp.replace(
    /(?:\.(\d{1,3}))?Z$/,
    (_match, digits: string | undefined) =>
      `.${(digits ?? '').padEnd(3, '0')}Z`,
  );
  // Date.parse normalizes impossible dates; they are not original event times.
  return new Date(at).toISOString() === canonical ? at : null;
}
