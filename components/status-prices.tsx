'use client';

import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { MarketPrice } from '@/app/api/market-prices/route';

const REFRESH_MS = 60_000;
const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

// SOL, BNB and ETH reference prices in the status bar. Display only.
export function StatusPrices() {
  const [prices, setPrices] = useState<MarketPrice[]>([]);

  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    const load = async () => {
      if (document.visibilityState === 'hidden') return;
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch('/api/market-prices', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const body = (await response.json()) as { prices?: MarketPrice[] };
        if (active && Array.isArray(body.prices)) setPrices(body.prices);
      } catch {
        // Keep the last prices; the next refresh tries again.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    document.addEventListener('visibilitychange', load);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, []);

  if (!prices.length) return null;
  return (
    <span className="status-prices" aria-label="Reference prices">
      {prices.map((price) => {
        const up = (price.change24h ?? 0) >= 0;
        return (
          <span
            key={price.symbol}
            className="status-price"
            title={
              price.change24h === null
                ? `${price.symbol} reference price`
                : `${price.symbol} ${up ? '+' : ''}${price.change24h.toFixed(2)}% in 24h`
            }
          >
            <b>{price.symbol}</b> {usd.format(price.usd)}
            {price.change24h !== null &&
              (up ? (
                <ArrowUpRight className="up" aria-hidden="true" />
              ) : (
                <ArrowDownRight className="down" aria-hidden="true" />
              ))}
          </span>
        );
      })}
    </span>
  );
}
