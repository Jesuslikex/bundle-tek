'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { usePublishPairMarketSelection } from './pair-market-selection';
import { ImportedPoolCandles } from './imported-pool-candles';
import { ImportedPoolTrades } from './imported-pool-trades';
import { MarketConditionReview } from './market-condition-review';
import { TokenStatsStrip } from './token-stats-strip';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { ImportedSwapReceipt } from '@/lib/imported-approval-history';
import { MARKET_CHAINS, type SavedTokenMarket } from '@/lib/token-market';
import {
  createForegroundMarketFeed,
  type MarketFeedState,
} from '@/lib/foreground-market-feed';
const money = (value: number | null) =>
  value === null
    ? 'Unavailable'
    : new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      }).format(value);
type MarketResponse = {
  id: string;
  revision: number;
  observations: SavedTokenMarket[];
  executionAllowed: boolean;
  error?: string;
};
export function MarketObservationChart({
  observations,
  pair,
}: {
  observations: SavedTokenMarket[];
  pair: string;
}) {
  const samples = observations.toReversed().flatMap((o) => {
    const price = o.pairs.find((p) => p.address === pair)?.priceUsd;
    return price
      ? [{ time: Date.parse(o.observedAt), price: Number(price) }]
      : [];
  });
  if (samples.length < 2)
    return (
      <p>
        Refresh this pair again to chart observed prices. Samples are read
        times, not ticks or candles.
      </p>
    );
  const low = Math.min(...samples.map((s) => s.price)),
    high = Math.max(...samples.map((s) => s.price));
  const timeSpan = samples.at(-1)!.time - samples[0].time;
  const points = samples
    .map(
      (s, i) =>
        `${20 + (timeSpan ? (s.time - samples[0].time) / timeSpan : i / (samples.length - 1)) * 560},${high === low ? 70 : 120 - ((s.price - low) / (high - low)) * 100}`,
    )
    .join(' ');
  return (
    <figure>
      {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Inline SVG price chart uses an accessible image role. */}
      <svg
        role="img"
        aria-label={`Observed USD prices for the selected pair, ${samples.length} samples`}
        viewBox="0 0 600 140"
        style={{ width: '100%', maxHeight: 180 }}
      >
        <title>Selected pair prices at saved read times</title>
        <line
          x1="20"
          x2="580"
          y1="120"
          y2="120"
          stroke="currentColor"
          opacity="0.25"
        />
        <polyline
          points={points}
          fill="none"
          stroke="#8b87ff"
          strokeWidth="2"
        />
      </svg>
      {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
      <figcaption>
        {samples.length} observed prices ·{' '}
        {new Date(samples[0].time).toLocaleString()} to{' '}
        {new Date(samples.at(-1)!.time).toLocaleString()}. This connects saved
        observations of this pair only; it is not an OHLC or continuous trade
        feed.
      </figcaption>
    </figure>
  );
}
export function ImportedTokenMarket({
  project,
  onReviewBuy,
}: {
  project: ImportedTokenProject;
  onReviewBuy?: (receipt: ImportedSwapReceipt) => void;
}) {
  const [observations, setObservations] = useState<SavedTokenMarket[]>([]),
    [selected, setSelected] = useState(''),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const feed = useRef<ReturnType<typeof createForegroundMarketFeed> | null>(
    null,
  );
  const [feedState, setFeedState] = useState<MarketFeedState>({
    status: 'off',
    reason: '',
    reads: 0,
  });
  const { chain, address } = project.document.token;
  const accept = useCallback(
    (data: {
      id: string;
      revision: number;
      observations: SavedTokenMarket[];
      executionAllowed: boolean;
    }) => {
      if (
        data.id !== project.id ||
        data.revision !== project.revision ||
        data.executionAllowed !== false ||
        !Array.isArray(data.observations) ||
        data.observations.length > 20 ||
        data.observations.some(
          (o) =>
            o.chain !== chain ||
            o.address !== address ||
            o.executionAllowed !== false ||
            !Array.isArray(o.pairs),
        )
      )
        throw new Error('Market observation context mismatch.');
      setObservations(data.observations);
      setSelected((old) =>
        data.observations[0]?.pairs.some((p) => p.address === old)
          ? old
          : (data.observations[0]?.pairs[0]?.address ?? ''),
      );
    },
    [project.id, project.revision, chain, address],
  );
  useEffect(() => {
    const c = new AbortController();
    pending.current = c;
    void fetch(
      `/api/imported-projects/market?${new URLSearchParams({ id: project.id, revision: String(project.revision) })}`,
      { signal: c.signal, cache: 'no-store' },
    )
      .then(async (response) => {
        const data = (await response.json()) as MarketResponse;
        if (!response.ok)
          throw new Error(
            data.error || 'Saved market observations unavailable.',
          );
        if (!c.signal.aborted) accept(data);
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(
            e instanceof Error
              ? e.message
              : 'Saved market observations unavailable.',
          );
      })
      .finally(() => {
        if (!c.signal.aborted) setBusy(false);
      });
    return () => pending.current?.abort();
  }, [project.id, project.revision, accept]);
  const refresh = useCallback(
    async (feedSignal?: AbortSignal): Promise<boolean> => {
      if (project.archived || !MARKET_CHAINS[chain]) return false;
      pending.current?.abort();
      const c = new AbortController();
      pending.current = c;
      const signal = feedSignal
        ? AbortSignal.any([c.signal, feedSignal])
        : c.signal;
      setBusy(true);
      setError('');
      try {
        const response = await fetch('/api/imported-projects/market', {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: project.id, revision: project.revision }),
        });
        const data = (await response.json()) as MarketResponse;
        if (!response.ok)
          throw new Error(data.error || 'Market observations unavailable.');
        if (signal.aborted) return false;
        accept(data);
        return true;
      } catch (e) {
        if (!signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Market observations unavailable.',
          );
        return false;
      } finally {
        if (pending.current === c) setBusy(false);
      }
    },
    [project.id, project.revision, project.archived, chain, accept],
  );
  useEffect(() => {
    const controller = createForegroundMarketFeed({
      available: () =>
        !document.hidden &&
        navigator.onLine &&
        !project.archived &&
        Boolean(MARKET_CHAINS[chain]),
      read: refresh,
      onState: setFeedState,
    });
    feed.current = controller;
    const visibility = () => {
      if (document.hidden) controller.pause('Tab hidden. Restart when ready.');
    };
    const offline = () =>
      controller.pause('Browser offline. Restart when connected.');
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('offline', offline);
    return () => {
      controller.destroy();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('offline', offline);
      if (feed.current === controller) feed.current = null;
    };
  }, [refresh, project.archived, chain]);
  const latest = observations[0],
    pair = latest?.pairs.find((p) => p.address === selected);
  usePublishPairMarketSelection(project.id, project.revision, pair?.address ?? null);
  return (
    <section
      className="wallet-warmup-panel imported-market-pane"
      aria-label="Imported token market"
    >
      <h3>Market observations</h3>
      {latest && pair && (
        <TokenStatsStrip
          pair={pair}
          symbol={project.document.token.symbol}
          observedAt={latest.observedAt}
        />
      )}
      <details className="market-data-coverage">
        <summary>Market data coverage and feed behavior</summary>
        <p>
          Public DEX Screener pair metrics. Refresh once or start the
          visible-project feed. The latest 20 observations and up to 20
          base-token pairs per read are retained. New reads replace the oldest
          sample. Provider prices are not executable quotes, wallet P&amp;L or
          verified trades.
        </p>
        <p>
          While enabled, reads repeat 30 seconds after each successful response.
          Hiding this tab, going offline, leaving this project or a failed read
          stops the feed. Restart explicitly to continue. This samples provider
          metrics and prices; it is not a tick or candle stream.
        </p>
      </details>
      <div className="wallet-roster-actions imported-market-toolbar">
        {latest && latest.pairs.length > 0 && (
          <label>
            Market pair{' '}
            <select
              aria-label="Market pair"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {latest.pairs.map((p) => (
                <option key={p.address} value={p.address}>
                  {p.dex} / {p.quoteSymbol} · {p.address.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button
          variant="outline"
          disabled={
            busy ||
            feedState.status === 'running' ||
            project.archived ||
            !MARKET_CHAINS[chain]
          }
          onClick={() => void refresh()}
        >
          Refresh market observation
        </Button>
        <Button
          variant="outline"
          disabled={
            feedState.status !== 'running' &&
            (busy || project.archived || !MARKET_CHAINS[chain])
          }
          onClick={() =>
            feedState.status === 'running'
              ? feed.current?.stop()
              : feed.current?.start()
          }
        >
          {feedState.status === 'running'
            ? 'Stop market feed'
            : 'Start market feed'}
        </Button>
      </div>
      <output style={{ display: 'block', marginTop: 8 }}>
        {feedState.status === 'running'
          ? `Market feed running. ${feedState.reads} successful feed reads this session.`
          : `Market feed ${feedState.status}. ${feedState.reason}`}
      </output>
      {!MARKET_CHAINS[chain] && (
        <p>
          This market provider currently supports Solana, Ethereum, Base and
          BNB.
        </p>
      )}
      {project.archived && (
        <p>
          Archived project. Saved observations remain readable; restore it to
          refresh.
        </p>
      )}
      {busy && <output>Loading market observations…</output>}
      {error && <p role="alert">{error}</p>}
      {!latest && !busy && <p>No market observations saved.</p>}
      {latest && (
        <>
          <p>
            {latest.source} · read{' '}
            {new Date(latest.observedAt).toLocaleString()} · captured project r
            {latest.projectRevision} · {observations.length}/20 saved reads.
          </p>
          {latest.projectRevision !== project.revision && (
            <p>
              Project metadata changed since this observation. Prices remain
              historical provider observations.
            </p>
          )}
          {!latest.pairs.length && (
            <p>
              No base-token pairs returned by the provider. This does not prove
              absence of trading or liquidity elsewhere.
            </p>
          )}
          {pair && (
            <>
              <div className="imported-market-board">
                <ImportedPoolCandles
                  key={pair.address}
                  project={project}
                  pool={pair.address}
                  feedRunning={feedState.status === 'running'}
                />
                <ImportedPoolTrades
                  key={`trades:${pair.address}`}
                  project={project}
                  pool={pair.address}
                  feedRunning={feedState.status === 'running'}
                  compact
                />
              </div>
              <details className="market-analysis-tools">
                <summary>Market observations and conditions</summary>
                <p>
                  {latest.returnedPairCount} returned pairs;{' '}
                  {latest.quoteOnlyPairCount} quote-token pairs omitted because
                  their base-token USD price does not price this token. Metrics
                  below belong to the selected pool, without aggregation.
                </p>
                <MarketConditionReview
                  key={`${project.id}:${project.revision}:${pair.address}`}
                  project={project}
                  observation={latest}
                  feedRunning={feedState.status === 'running'}
                  pair={pair.address}
                  onReviewBuy={onReviewBuy}
                />
                <p className="warmup-address">
                  Pair: {pair.address} ·{' '}
                  <a href={pair.url} target="_blank" rel="noreferrer">
                    View on DEX Screener
                  </a>
                </p>
                <p>
                  Exact USD price: {pair.priceUsd ?? 'unavailable'}. Reported
                  market cap {money(pair.marketCapUsd)}, liquidity{' '}
                  {money(pair.liquidityUsd)}. Provider valuations and windows
                  can lag. Read time does not establish when the provider last
                  observed a trade.
                </p>
                <MarketObservationChart
                  observations={observations}
                  pair={pair.address}
                />
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}
