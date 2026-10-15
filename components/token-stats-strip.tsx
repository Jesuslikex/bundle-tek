'use client';
import { useEffect, useState } from 'react';
import type { SavedTokenMarket } from '@/lib/token-market';
import {
  STALE_AFTER_MS,
  compactUsd,
  readAge,
  shortUsdPrice,
  signedPercent,
} from '@/lib/token-stats-format';

type Pair = SavedTokenMarket['pairs'][number];

/**
 * Proxima-style headline numbers above the token chart, from the latest saved
 * provider observation of the selected pair. Provider metrics, not quotes.
 */
export function TokenStatsStrip({
  pair,
  symbol,
  observedAt,
  now: fixedNow,
}: {
  pair: Pair;
  symbol: string;
  observedAt: string;
  /** Fixed clock for tests; otherwise a clock that ticks every 30 seconds. */
  now?: number;
}) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (fixedNow !== undefined) return;
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [fixedNow]);
  const now = fixedNow ?? clock;
  const stale = now - Date.parse(observedAt) > STALE_AFTER_MS;
  const change = pair.change24h;
  const stats = [
    {
      label: 'Price',
      value: shortUsdPrice(pair.priceUsd),
      title: pair.priceUsd === null ? undefined : `$${pair.priceUsd}`,
    },
    { label: 'Market cap', value: compactUsd(pair.marketCapUsd) },
    { label: 'Liquidity', value: compactUsd(pair.liquidityUsd) },
    { label: '24h volume', value: compactUsd(pair.volume24hUsd) },
    {
      label: '24h change',
      value: signedPercent(change),
      tone:
        change === null || change === 0
          ? undefined
          : change > 0
            ? 'up'
            : 'down',
    },
  ];
  return (
    <section
      className="token-stats-strip"
      aria-label={`${symbol} market stats`}
    >
      <dl>
        {stats.map((s) => (
          <div key={s.label}>
            <dt>{s.label}</dt>
            <dd title={s.title} data-tone={s.tone}>
              {s.value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="token-stats-source" data-stale={stale || undefined}>
        {pair.dex} / {pair.quoteSymbol} ·{' '}
        <time
          dateTime={observedAt}
          title={new Date(observedAt).toLocaleString()}
        >
          read {readAge(observedAt, now)}
        </time>
        {stale && ' · stale, refresh for current numbers'}
      </p>
    </section>
  );
}
