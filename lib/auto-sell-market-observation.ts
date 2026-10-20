import type { AutoSellObservedTrade } from './auto-sell';

export const AUTO_SELL_MARKET_MAX_AGE_MS = 60000;

/** A successful HTTP read cannot renew the age of an old trade price. */
export function autoSellMarketObservation(
  trades: AutoSellObservedTrade[],
  now: number,
  maximumAge = AUTO_SELL_MARKET_MAX_AGE_MS,
) {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(maximumAge) ||
    maximumAge < 0
  )
    return null;
  let latest: { priceUsd: string; at: number } | null = null;
  for (const trade of trades) {
    if (
      typeof trade.timestamp !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(
        trade.timestamp,
      )
    )
      continue;
    const at = Date.parse(trade.timestamp),
      price = Number(trade.priceUsd);
    if (
      !Number.isSafeInteger(at) ||
      at > now ||
      now - at > maximumAge ||
      !Number.isFinite(price) ||
      price <= 0
    )
      continue;
    if (!latest || at > latest.at) latest = { priceUsd: trade.priceUsd, at };
  }
  return latest;
}
