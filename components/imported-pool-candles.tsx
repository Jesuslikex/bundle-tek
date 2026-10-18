'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import {
  CANDLE_INTERVALS,
  MAX_SAVED_CANDLES,
  type CandleInterval,
  type PoolCandles,
  type CandleCurrency,
  SOL_CANDLE_QUOTE,
} from '@/lib/pool-candles';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import { chartTradeMarkers } from '@/lib/chart-trade-markers';
import { ChartExecutionAverages } from './chart-execution-averages';
import { chartExecutionAverages } from '@/lib/chart-execution-averages';
import { chartPriceContext } from '@/lib/chart-price-context';
import { chartCapSupply, type ChartSupply } from '@/lib/chart-cap-supply';
import {
  chartDrawingStorageKey,
  parseChartDrawingDocument,
} from '@/lib/chart-drawing-document';
import {
  visibleTrendLine,
  type ChartAnchor,
  type ChartTrendLine,
} from '@/lib/chart-trend-line';
import {
  importedTradePage,
  type ImportedTradeReceipt,
} from '@/lib/imported-trade-ledger';
import { subscribeImportedReceiptSaved } from '@/lib/imported-receipt-events';
import {
  subscribeSupplyAlertChart,
  type SupplyAlertChartRequest,
} from '@/lib/supply-alert-chart-events';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import {
  createForegroundMarketFeed,
  type MarketFeedState,
} from '@/lib/foreground-market-feed';
import {
  candleWindow,
  candleContainingTime,
  focusCandleWindow,
  dragCandleWindow,
  moveCandleWindow,
  nearestCandle,
  zoomCandleWindow,
} from '@/lib/candle-window';
type Result = {
  id: string;
  revision: number;
  executionAllowed: boolean;
  observations: PoolCandles[];
  error?: string;
};
export function PoolCandleChart({
  snapshot,
  markers,
  projectId,
  revision,
  supplyToken,
  executionAverages,
}: {
  snapshot: PoolCandles;
  markers?: ReturnType<typeof chartTradeMarkers>;
  projectId?: string;
  revision?: number;
  supplyToken?: ChartSupply;
  executionAverages?: ReturnType<typeof chartExecutionAverages>;
}) {
  const context = chartPriceContext(snapshot, projectId);
  const unit = snapshot.currency === 'sol' ? 'SOL' : 'USD',
    prefix = unit === 'SOL' ? 'SOL ' : '$',
    volumeUnit = unit === 'SOL' ? 'provider units' : 'USD';
  const [capMode, setCapMode] = useState(false);
  const capSupply = chartCapSupply(snapshot, supplyToken);
  const showCap = capMode && capSupply !== null;
  const displayed = (price: number) => price * (showCap ? capSupply! : 1);
  const [view, setView] = useState<{
    context: string;
    size: number;
    end: number | null;
  }>({ context, size: 100, end: null });
  const [selection, setSelection] = useState<{
    context: string;
    time: number;
  } | null>(null);
  const [guideTool, setGuideTool] = useState(false);
  const [trendTool, setTrendTool] = useState(false);
  const [trendStart, setTrendStart] = useState<ChartAnchor | null>(null);
  const [trendLines, setTrendLines] = useState<ChartTrendLine[]>([]);
  const [trendMessage, setTrendMessage] = useState('');
  const [drawingStorageMessage, setDrawingStorageMessage] = useState('');
  const [guideInput, setGuideInput] = useState('');
  const [priceGuides, setPriceGuides] = useState<{
    context: string;
    prices: number[];
  }>({ context, prices: [] });
  const guides = priceGuides.context === context ? priceGuides.prices : [];
  if (priceGuides.context !== context) {
    setCapMode(false);
    setGuideTool(false);
    setTrendTool(false);
    setTrendStart(null);
    setTrendLines([]);
    setTrendMessage('');
    setDrawingStorageMessage('');
    setGuideInput('');
    setPriceGuides({ context, prices: [] });
  }
  function saveDrawings() {
    if (!projectId) return;
    try {
      const text = JSON.stringify({
        format: 'bundle-chart-drawings-v1',
        context,
        savedAt: new Date().toISOString(),
        guides,
        trends: trendLines,
      });
      parseChartDrawingDocument(text, context);
      localStorage.setItem(chartDrawingStorageKey(context), text);
      setDrawingStorageMessage(
        'Drawings saved in this browser for this project, pool and interval.',
      );
    } catch {
      setDrawingStorageMessage(
        'Drawings could not be saved. Browser storage may be unavailable or full. Your current drawings remain on the chart.',
      );
    }
  }
  function restoreDrawings() {
    if (!projectId) return;
    try {
      const text = localStorage.getItem(chartDrawingStorageKey(context));
      if (text === null) {
        setDrawingStorageMessage(
          'No drawings saved in this browser for this project, pool and interval.',
        );
        return;
      }
      const saved = parseChartDrawingDocument(text, context);
      setPriceGuides({ context, prices: saved.guides });
      setTrendLines(saved.trends);
      setGuideTool(false);
      setTrendTool(false);
      setTrendStart(null);
      setTrendMessage('');
      setDrawingStorageMessage(
        `Restored drawings saved ${new Date(saved.savedAt).toLocaleString()}.`,
      );
    } catch {
      setDrawingStorageMessage(
        'Saved drawings could not be restored. Browser storage may be unavailable or the saved data invalid. Your current drawings remain on the chart.',
      );
    }
  }
  function addTrendPoint(point: ChartAnchor) {
    if (!Number.isFinite(point.price) || point.price <= 0) return;
    if (!trendStart) {
      setTrendStart(point);
      setTrendMessage(
        'First point placed. Choose another candle for the second point.',
      );
      return;
    }
    if (point.time === trendStart.time) {
      setTrendMessage('Choose a different candle for the second point.');
      return;
    }
    setTrendLines((old) =>
      old.length < 8 ? [...old, { first: trendStart, second: point }] : old,
    );
    setTrendStart(null);
    setTrendTool(false);
    setTrendMessage('Trend line added.');
  }
  function addGuide(price: number) {
    if (!Number.isFinite(price) || price <= 0) return;
    setTrendTool(false);
    setTrendStart(null);
    setTrendMessage('');
    setPriceGuides((old) => {
      const prices = old.context === context ? old.prices : [];
      if (prices.includes(price) || prices.length >= 8) return old;
      return { context, prices: [...prices, price] };
    });
    setGuideTool(false);
    setGuideInput('');
  }
  const drag = useRef<{
    pointer: number;
    context: string;
    x: number;
    y: number;
    width: number;
    end: number;
    size: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const chartButton = useRef<HTMLButtonElement>(null);
  const [plotWidth, setPlotWidth] = useState(610);
  const hasCandles = snapshot.candles.length > 0;
  useEffect(() => {
    const element = chartButton.current;
    if (!element) return;
    const resize = () => {
      const width = Math.round(element.getBoundingClientRect().width);
      if (width < 1) return;
      drag.current = null;
      setPlotWidth(Math.max(120, width));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [context, hasCandles]);
  const [alertInspection, setAlertInspection] = useState<{
    context: string;
    candleTime: number;
    request: SupplyAlertChartRequest;
  } | null>(null);
  useEffect(() => {
    if (!projectId || !revision || snapshot.chain !== 'Solana') return;
    return subscribeSupplyAlertChart(
      { projectId, revision, mint: snapshot.address },
      (request) => {
        const candle = candleContainingTime(
          snapshot.candles,
          request.transaction?.blockTime ?? Date.parse(request.to) / 1000,
          CANDLE_INTERVALS[snapshot.interval].seconds,
        );
        if (!candle)
          return 'The selected movement time is outside loaded candles or falls in a data gap. Load the relevant history or choose another interval, then inspect again.';
        drag.current = null;
        setView((old) => {
          const size = old.context === context ? old.size : 100;
          return {
            context,
            size,
            end: focusCandleWindow(snapshot.candles, size, candle.time),
          };
        });
        setSelection({ context, time: candle.time });
        setAlertInspection({ context, candleTime: candle.time, request });
        chartButton.current?.focus({ preventScroll: true });
        chartButton.current?.scrollIntoView({
          block: 'center',
          behavior: 'instant',
        });
        return null;
      },
    );
  }, [context, projectId, revision, snapshot]);
  const size = view.context === context ? view.size : 100;
  const endTime = view.context === context ? view.end : null;
  const window = candleWindow(snapshot.candles, size, endTime);
  const rows = window.rows;
  const selected =
    rows.find(
      (c) => selection?.context === context && c.time === selection.time,
    ) ?? rows.at(-1);
  const visibleMarkers = markers?.groups.filter((g) =>
    rows.some((c) => c.time === g.time),
  );
  if (!rows.length)
    return (
      <p>
        No candles returned. This does not establish that the pool has no
        activity.
      </p>
    );
  const low = Math.min(...rows.map((c) => c.low)),
    high = Math.max(...rows.map((c) => c.high));
  const y = (v: number) =>
    high === low ? 110 : 20 + ((high - v) / (high - low)) * 180;
  const averageLevels =
    unit === 'SOL' && executionAverages
      ? (['buy', 'sell'] as const).flatMap((side) => {
          const value = executionAverages[side];
          if (!value) return [];
          const price = Number(value.numerator) / Number(value.denominator);
          return Number.isFinite(price) && price > 0
            ? [{ side, price, inRange: price >= low && price <= high }]
            : [];
        })
      : [];
  const start = rows[0].time,
    end = rows.at(-1)!.time;
  const plotSpan = plotWidth - 80;
  const x = (v: number) =>
    end === start
      ? 55 + plotSpan / 2
      : 55 + ((v - start) / (end - start)) * plotSpan;
  const width = Math.max(1, Math.min(9, (plotSpan / rows.length) * 0.6));
  const maxVolume = Math.max(...rows.map((c) => c.volume));
  function zoom(nextSize: number) {
    drag.current = null;
    setView({
      context,
      size: nextSize,
      end: zoomCandleWindow(
        snapshot.candles,
        size,
        endTime,
        nextSize,
        selected!.time,
      ),
    });
  }
  return (
    <figure>
      {alertInspection?.context === context &&
        alertInspection.candleTime === selected?.time && (
          <output style={{ display: 'block' }}>
            Inspecting wallet{' '}
            <code className="warmup-address">
              {alertInspection.request.wallet}
            </code>{' '}
            movement observed between{' '}
            {new Date(alertInspection.request.from).toLocaleString()} and{' '}
            {new Date(alertInspection.request.to).toLocaleString()}.
            {alertInspection.request.transaction ? (
              <>
                {' '}
                Selected transaction{' '}
                <code className="warmup-address">
                  {alertInspection.request.transaction.signature}
                </code>
                , slot {alertInspection.request.transaction.slot}, recorded
                block time{' '}
                {new Date(
                  alertInspection.request.transaction.blockTime * 1000,
                ).toLocaleString()}
                . The selected candle contains that block time. A decoded token
                change does not establish a buy/sell or execution price.
              </>
            ) : (
              <>
                {' '}
                The selected candle contains the observation end. Balance
                observations do not establish the transaction time or a
                buy/sell.
              </>
            )}
          </output>
        )}
      {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- SVG candle plot uses an accessible image role. */}

      {trendTool && (
        <p role="status">
          {trendStart ? 'Place the second point' : 'Place the first point'} by
          clicking the price plot. Enter uses the inspected candle close;
          Left/Right selects another candle. Escape cancels.
        </p>
      )}
      {trendMessage && <p role="status">{trendMessage}</p>}
      {trendLines.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2"
          aria-label="Trend lines"
        >
          {trendLines.map((line, index) => (
            <Button
              key={`${line.first.time}:${line.second.time}:${index}`}
              type="button"
              variant="outline"
              aria-label={`Remove trend line ${index + 1}`}
              title={`${new Date(line.first.time * 1000).toLocaleString()} ${prefix}${line.first.price.toPrecision(6)} to ${new Date(line.second.time * 1000).toLocaleString()} ${prefix}${line.second.price.toPrecision(6)}`}
              onClick={() =>
                setTrendLines((old) => old.filter((_, i) => i !== index))
              }
            >
              Trend {index + 1} · Remove
            </Button>
          ))}
          <p className="text-xs text-muted-foreground">
            Up to 8 trend lines for this pool and interval, kept until context
            changes or reload unless saved and restored.
          </p>
        </div>
      )}
      {guideTool && (
        <p role="status">
          Click the price plot to place a guide. With the chart focused, press
          Enter to use the inspected candle close or Escape to cancel.
        </p>
      )}
      {guides.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2"
          aria-label="Price guides"
        >
          {guides.map((price) => (
            <Button
              key={price}
              type="button"
              variant="outline"
              aria-label={`Remove price guide ${prefix}${price}`}
              onClick={() =>
                setPriceGuides((old) => ({
                  context,
                  prices:
                    old.context === context
                      ? old.prices.filter((value) => value !== price)
                      : [],
                }))
              }
            >
              {prefix}
              {price.toPrecision(6)} · Remove
              {price < low || price > high ? ' (outside view)' : ''}
            </Button>
          ))}
          <p className="text-xs text-muted-foreground">
            Up to 8 visual guides for this pool and interval, kept until you
            change chart context or reload unless saved and restored. Guides do
            not create trade orders.
          </p>
        </div>
      )}
      <button
        type="button"
        aria-label="Inspect chart candles"
        ref={chartButton}
        style={{
          display: 'block',
          width: '100%',
          padding: 0,
          background: 'transparent',
          border: 0,
          color: 'inherit',
          cursor: 'crosshair',
          touchAction: 'pan-y',
        }}
        onPointerDown={(e) => {
          suppressClick.current = false;
          if (guideTool || trendTool) return;
          if (!e.isPrimary || e.button !== 0) return;
          const svg = e.currentTarget.querySelector('svg');
          const matrix = svg?.getScreenCTM();
          if (!matrix) return;
          const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(
            matrix.inverse(),
          );
          if (
            point.x < 55 ||
            point.x > plotWidth - 15 ||
            point.y < 20 ||
            point.y > 300
          )
            return;
          drag.current = {
            pointer: e.pointerId,
            context,
            x: e.clientX,
            y: e.clientY,
            width: plotSpan * Math.hypot(matrix.a, matrix.b),
            end,
            size,
            moved: false,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const current = drag.current;
          if (
            !current ||
            current.pointer !== e.pointerId ||
            current.context !== context
          )
            return;
          const delta = e.clientX - current.x;
          if (
            !current.moved &&
            (Math.abs(delta) < 6 ||
              Math.abs(delta) <= Math.abs(e.clientY - current.y))
          )
            return;
          current.moved = true;
          suppressClick.current = true;
          setView({
            context,
            size: current.size,
            end: dragCandleWindow(
              snapshot.candles,
              current.size,
              current.end,
              delta,
              current.width,
            ),
          });
        }}
        onPointerUp={(e) => {
          if (drag.current?.pointer !== e.pointerId) return;
          drag.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
          suppressClick.current = false;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onClick={(e) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          const svg = e.currentTarget.querySelector('svg');
          const matrix = svg?.getScreenCTM();
          if (!matrix || e.detail === 0) return;
          const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(
            matrix.inverse(),
          );
          if (
            point.x < 55 ||
            point.x > plotWidth - 15 ||
            point.y < 20 ||
            point.y > 300
          )
            return;
          if (guideTool) {
            if (point.y <= 200)
              addGuide(high - ((point.y - 20) / 180) * (high - low));
            return;
          }
          if (trendTool) {
            if (point.y > 200) return;
            const candle = nearestCandle(
              rows,
              start + ((point.x - 55) / plotSpan) * (end - start),
            );
            if (candle)
              addTrendPoint({
                time: candle.time,
                price: high - ((point.y - 20) / 180) * (high - low),
              });
            return;
          }
          const candle = nearestCandle(
            rows,
            start + ((point.x - 55) / plotSpan) * (end - start),
          );
          if (candle) setSelection({ context, time: candle.time });
        }}
        onKeyDown={(e) => {
          if (trendTool && (e.key === 'Enter' || e.key === 'Escape')) {
            e.preventDefault();
            if (e.key === 'Enter' && selected)
              addTrendPoint({ time: selected.time, price: selected.close });
            else {
              setTrendTool(false);
              setTrendStart(null);
              setTrendMessage('');
            }
            return;
          }
          if (guideTool && (e.key === 'Enter' || e.key === 'Escape')) {
            e.preventDefault();
            if (e.key === 'Enter' && selected) addGuide(selected.close);
            else setGuideTool(false);
            return;
          }
          if (['+', '=', '-'].includes(e.key)) {
            e.preventDefault();
            if (e.key === '-') {
              if (size < snapshot.candles.length && size < 500)
                zoom(Math.min(500, Math.ceil(size * 1.5)));
            } else if (size > 12) zoom(Math.max(12, Math.floor(size / 1.5)));
            return;
          }
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key))
            return;
          e.preventDefault();
          if (e.shiftKey && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
            setView({
              context,
              size,
              end: moveCandleWindow(
                snapshot.candles,
                size,
                endTime,
                e.key === 'ArrowLeft' ? -1 : 1,
              ),
            });
            return;
          }
          const index = rows.findIndex((c) => c.time === selected?.time);
          const next =
            e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? rows.length - 1
                : Math.max(
                    0,
                    Math.min(
                      rows.length - 1,
                      index + (e.key === 'ArrowLeft' ? -1 : 1),
                    ),
                  );
          setSelection({ context, time: rows[next].time });
        }}
      >
        <svg
          role="img"
          aria-label={`${rows.length} ${snapshot.interval} ${showCap ? 'estimated market cap ' + unit : unit + ' price'} candles for selected pool`}
          viewBox={`0 0 ${plotWidth} 310`}
          style={{ width: '100%', height: 310, display: 'block' }}
        >
          <title>
            {`${showCap ? 'Estimated market cap using saved total supply.' : 'Provider OHLC prices.'} ${unit} denomination. Green closes at or above open; red closes below open.`}
          </title>
          {[high, low].map((v, i) => (
            <g key={i}>
              <line
                x1="55"
                x2={plotWidth - 15}
                y1={i ? 200 : 20}
                y2={i ? 200 : 20}
                stroke="currentColor"
                opacity="0.2"
              />
              <text x="2" y={i ? 200 : 20} fill="currentColor" fontSize="10">
                {displayed(v).toPrecision(4)}
              </text>
            </g>
          ))}
          {trendLines.map((line, index) => {
            const visible = visibleTrendLine(line, { start, end, low, high });
            if (!visible) return null;
            return (
              <g key={`trend:${index}`} aria-label={`Trend line ${index + 1}`}>
                <title>Visual trend line {index + 1}. No trade order.</title>
                <line
                  x1={x(visible.first.time)}
                  x2={x(visible.second.time)}
                  y1={y(visible.first.price)}
                  y2={y(visible.second.price)}
                  stroke="#fbbf24"
                  strokeWidth="2"
                />
              </g>
            );
          })}
          {trendStart &&
            trendTool &&
            trendStart.time >= start &&
            trendStart.time <= end &&
            trendStart.price >= low &&
            trendStart.price <= high && (
              <circle
                aria-label="First trend line point"
                cx={x(trendStart.time)}
                cy={y(trendStart.price)}
                r="4"
                fill="#fbbf24"
              />
            )}
          {rows.map((c) => (
            <g
              key={c.time}
              fill={c.close >= c.open ? '#34d399' : '#fb7185'}
              stroke={c.close >= c.open ? '#34d399' : '#fb7185'}
            >
              <title>{`${new Date(c.time * 1000).toLocaleString()}: ${showCap ? 'Estimated market cap' : 'Token price'} ${unit} O ${displayed(c.open)}, H ${displayed(c.high)}, L ${displayed(c.low)}, C ${displayed(c.close)}, volume ${volumeUnit} ${c.volume}`}</title>
              <line
                x1={x(c.time)}
                x2={x(c.time)}
                y1={y(c.high)}
                y2={y(c.low)}
              />
              <rect
                x={x(c.time) - width / 2}
                y={Math.min(y(c.open), y(c.close))}
                width={width}
                height={Math.max(1, Math.abs(y(c.open) - y(c.close)))}
              />
            </g>
          ))}
          {selected && (
            <line
              x1={x(selected.time)}
              x2={x(selected.time)}
              y1="20"
              y2="200"
              stroke="currentColor"
              opacity="0.4"
              strokeDasharray="3 3"
            />
          )}
          {guides
            .filter((price) => price >= low && price <= high)
            .map((price) => (
              <g
                key={`guide:${price}`}
                aria-label={`Price guide ${prefix}${price}`}
              >
                <title>{`Visual price guide: ${prefix}${price}. No trade order.`}</title>
                <line
                  x1="55"
                  x2={plotWidth - 15}
                  y1={y(price)}
                  y2={y(price)}
                  stroke="#60a5fa"
                  strokeDasharray="6 4"
                />
                <text
                  x={plotWidth - 18}
                  y={Math.max(30, y(price) - 5)}
                  textAnchor="end"
                  fill="#60a5fa"
                  fontSize="11"
                >
                  {prefix}
                  {displayed(price).toPrecision(6)}
                </text>
              </g>
            ))}
          {averageLevels
            .filter((a) => a.inRange)
            .map((a) => (
              <g
                key={`average:${a.side}`}
                aria-label={`Recorded average ${a.side} price SOL`}
              >
                <title>{`Recorded weighted ${a.side} average: ${a.price} SOL/token, loaded receipts across routes.`}</title>
                <line
                  x1="55"
                  x2={plotWidth - 15}
                  y1={y(a.price)}
                  y2={y(a.price)}
                  stroke={a.side === 'buy' ? '#34d399' : '#fb7185'}
                  strokeDasharray="5 5"
                />
                <text
                  x={plotWidth - 18}
                  y={Math.max(30, y(a.price) - 5)}
                  textAnchor="end"
                  fill={a.side === 'buy' ? '#34d399' : '#fb7185'}
                  fontSize="10"
                >
                  Avg {a.side}: {displayed(a.price).toPrecision(6)} SOL
                </text>
              </g>
            ))}
          {rows.map((c) => (
            <rect
              key={`volume:${c.time}`}
              x={x(c.time) - width / 2}
              y={300 - (maxVolume ? (c.volume / maxVolume) * 32 : 0)}
              width={width}
              height={maxVolume ? (c.volume / maxVolume) * 32 : 0}
              fill={c.close >= c.open ? '#34d399' : '#fb7185'}
              opacity="0.45"
            >
              <title>{`${new Date(c.time * 1000).toLocaleString()}: volume ${volumeUnit} ${c.volume}`}</title>
            </rect>
          ))}
          <text x="2" y="285" fill="currentColor" fontSize="9">
            Vol
          </text>
          {visibleMarkers?.map((g) => (
            <g
              key={`${g.time}:${g.side}`}
              transform={`translate(${x(g.time) + (g.side === 'Buy' ? -5 : 5)},230)`}
            >
              <title>
                {g.side}: {g.receipts.length} finalized token trades in this
                candle interval. Marker position does not show execution price.
              </title>
              <circle r="7" fill={g.side === 'Buy' ? '#34d399' : '#fb7185'} />
              <text textAnchor="middle" y="3" fill="#111827" fontSize="8">
                {g.side === 'Buy' ? 'B' : 'S'}
              </text>
              {g.receipts.length > 1 && (
                <text
                  textAnchor="middle"
                  y="20"
                  fill="currentColor"
                  fontSize="9"
                >
                  {g.receipts.length}
                </text>
              )}
            </g>
          ))}
        </svg>
      </button>
      {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
      <details className="candle-chart-help">
        <summary>Explore the chart</summary>
        <p>
          Drag horizontally to explore loaded history. Click or tap the chart to
          inspect the nearest recorded candle. With the chart focused, use
          Left/Right or Home/End to inspect. Shift+Left/Right moves the chart
          window. Use +/− to zoom around the inspected candle.
        </p>
      </details>
      <figcaption>
        {rows.length} of {snapshot.candles.length} loaded {snapshot.interval}{' '}
        candles. {new Date(start * 1000).toLocaleString()} to{' '}
        {new Date(end * 1000).toLocaleString()}. Gaps are preserved; the newest
        interval may be incomplete. Volume bars scale to this window.{' '}
        {markers &&
          `${visibleMarkers?.reduce((n, g) => n + g.receipts.length, 0) ?? 0} recorded trades visible.`}
      </figcaption>
      <div className="wallet-roster-actions">
        <label>
          Visible candles{' '}
          <select
            aria-label="Visible candles"
            value={size}
            onChange={(e) => zoom(Number(e.target.value))}
          >
            {![24, 100, 500].includes(size) && (
              <option value={size}>{size} candles</option>
            )}
            <option value={24}>24 candles</option>
            <option value={100}>100 candles</option>
            <option value={500}>All loaded candles</option>
          </select>
        </label>
        <Button
          variant="outline"
          disabled={size <= 12}
          onClick={() => zoom(Math.max(12, Math.floor(size / 1.5)))}
        >
          Zoom chart in
        </Button>
        <Button
          variant="outline"
          disabled={size >= snapshot.candles.length || size >= 500}
          onClick={() => zoom(Math.min(500, Math.ceil(size * 1.5)))}
        >
          Zoom chart out
        </Button>
        <Button
          variant="outline"
          disabled={!window.earlier}
          onClick={() =>
            setView({
              context,
              size,
              end: moveCandleWindow(snapshot.candles, size, endTime, -1),
            })
          }
        >
          Earlier chart window
        </Button>
        <Button
          variant="outline"
          disabled={!window.later}
          onClick={() =>
            setView({
              context,
              size,
              end: moveCandleWindow(snapshot.candles, size, endTime, 1),
            })
          }
        >
          Later chart window
        </Button>
        <Button
          variant="outline"
          disabled={endTime === null}
          onClick={() => setView({ context, size, end: null })}
        >
          Latest chart window
        </Button>
      </div>
      <div
        className="flex flex-wrap items-center gap-2"
        aria-label="Chart value scale"
      >
        <Button
          type="button"
          variant="outline"
          aria-pressed={!showCap}
          onClick={() => setCapMode(false)}
        >
          Token price
        </Button>
        <Button
          type="button"
          variant="outline"
          aria-pressed={showCap}
          disabled={capSupply === null}
          onClick={() => setCapMode(true)}
        >
          Market cap
        </Button>
      </div>
      {showCap && supplyToken && (
        <p className="text-xs text-muted-foreground">
          Estimated market cap: candle price × saved total supply (
          {capSupply!.toLocaleString()} tokens, observed{' '}
          {new Date(supplyToken.observedAt).toLocaleString()}). The same supply
          applies to all candles; this does not reconstruct historical
          circulating supply. Drawing inputs use token-price {unit}; plotted
          guide labels use the selected scale.
        </p>
      )}
      <label>
        Inspect candle{' '}
        <select
          aria-label="Inspect candle"
          value={selected?.time ?? ''}
          onChange={(e) =>
            setSelection({ context, time: Number(e.target.value) })
          }
        >
          {rows.map((c) => (
            <option key={c.time} value={c.time}>
              {new Date(c.time * 1000).toLocaleString()}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <p aria-live="polite">
          {new Date(selected.time * 1000).toLocaleString()} ·{' '}
          {showCap ? 'Estimated market cap' : 'Token price'} · Open {prefix}
          {displayed(selected.open).toPrecision(6)} · High {prefix}
          {displayed(selected.high).toPrecision(6)} · Low {prefix}
          {displayed(selected.low).toPrecision(6)} · Close {prefix}
          {displayed(selected.close).toPrecision(6)} · Volume {volumeUnit}{' '}
          {selected.volume.toLocaleString()}
        </p>
      )}
      <details className="candle-chart-tools">
        <summary>Chart drawing tools</summary>
        {projectId && (
          <div
            className="flex flex-wrap items-center gap-2"
            aria-label="Drawing storage"
          >
            <Button type="button" variant="outline" onClick={saveDrawings}>
              Save chart drawings
            </Button>
            <Button type="button" variant="outline" onClick={restoreDrawings}>
              Restore chart drawings
            </Button>
            <p className="text-xs text-muted-foreground">
              Stored in this browser only. Restore replaces current drawings.
              Save again after editing; clearing browser data removes saved
              drawings.
            </p>
          </div>
        )}
        {drawingStorageMessage && (
          <output className="block">{drawingStorageMessage}</output>
        )}
        <div
          className="flex flex-wrap items-center gap-2"
          aria-label="Chart drawings"
        >
          <Button
            type="button"
            variant="outline"
            aria-pressed={guideTool}
            disabled={guides.length >= 8}
            onClick={() => {
              drag.current = null;
              setTrendTool(false);
              setTrendStart(null);
              setTrendMessage('');
              setGuideTool(!guideTool);
            }}
          >
            {guideTool ? 'Cancel price guide' : 'Draw price guide'}
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-pressed={trendTool}
            disabled={trendLines.length >= 8}
            onClick={() => {
              drag.current = null;
              setGuideTool(false);
              setTrendStart(null);
              setTrendMessage('');
              setTrendTool(!trendTool);
            }}
          >
            {trendTool ? 'Cancel trend line' : 'Draw trend line'}
          </Button>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addGuide(Number(guideInput));
            }}
          >
            <label>
              Guide {unit}{' '}
              <input
                type="number"
                step="any"
                min="0"
                required
                aria-label={`Price guide ${unit}`}
                value={guideInput}
                onChange={(e) => setGuideInput(e.target.value)}
                style={{ width: 110 }}
              />
            </label>
            <Button
              type="submit"
              variant="outline"
              disabled={
                guides.length >= 8 ||
                !Number.isFinite(Number(guideInput)) ||
                Number(guideInput) <= 0
              }
            >
              Add guide
            </Button>
          </form>
        </div>
      </details>
      {averageLevels.some((a) => !a.inRange) && (
        <output>
          Recorded averages outside the current candle price range are not
          drawn. Exact loaded-receipt prices remain available below.
        </output>
      )}
      <details>
        <summary>Inspect OHLC and volume table</summary>
        <div style={{ overflowX: 'auto', maxHeight: 320 }}>
          <table className="project-table">
            <caption>
              {showCap ? 'Estimated market cap' : 'Token price'} {unit}. Volume:{' '}
              {volumeUnit}.
            </caption>
            <thead>
              <tr>
                {[
                  'Time',
                  'Open',
                  'High',
                  'Low',
                  'Close',
                  `Volume ${volumeUnit}`,
                ].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.toReversed().map((c) => (
                <tr key={c.time}>
                  <td>{new Date(c.time * 1000).toLocaleString()}</td>
                  {[c.open, c.high, c.low, c.close, c.volume].map((v, i) => (
                    <td key={i}>{i < 4 ? displayed(v) : v}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
export function ImportedPoolCandles({
  project,
  pool,
  feedRunning,
}: {
  project: ImportedTokenProject;
  pool: string;
  feedRunning: boolean;
}) {
  const [interval, setInterval] = useState<CandleInterval>('1h'),
    [saved, setSaved] = useState<PoolCandles[]>([]),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const [currency, setCurrency] = useState<CandleCurrency>('usd');
  const pending = useRef<AbortController | null>(null);
  const accept = useCallback(
    (data: Result) => {
      if (
        data.id !== project.id ||
        data.revision !== project.revision ||
        data.executionAllowed !== false ||
        !Array.isArray(data.observations) ||
        data.observations.length > 20 ||
        data.observations.some(
          (s) =>
            s.chain !== project.document.token.chain ||
            s.address !== project.document.token.address ||
            s.executionAllowed !== false ||
            (s.currency ?? 'usd') !== currency ||
            (currency === 'sol' && s.quoteMint !== SOL_CANDLE_QUOTE),
        )
      )
        throw new Error('Candle context mismatch.');
      setSaved(data.observations);
    },
    [
      project.id,
      project.revision,
      project.document.token.chain,
      project.document.token.address,
      currency,
    ],
  );
  useEffect(() => {
    const c = new AbortController();
    pending.current = c;
    void Promise.resolve()
      .then(() => {
        if (c.signal.aborted) return null;
        setBusy(true);
        setError('');
        return fetch(
          `/api/imported-projects/candles?${new URLSearchParams({ id: project.id, revision: String(project.revision), currency })}`,
          { signal: c.signal, cache: 'no-store' },
        );
      })
      .then(async (response) => {
        if (!response) return;
        const data = (await response.json()) as Result;
        if (!response.ok)
          throw new Error(data.error || 'Saved candles unavailable.');
        if (
          data.id !== project.id ||
          data.revision !== project.revision ||
          data.executionAllowed !== false ||
          !Array.isArray(data.observations) ||
          data.observations.length > 20 ||
          data.observations.some(
            (s) =>
              s.chain !== project.document.token.chain ||
              s.address !== project.document.token.address ||
              s.executionAllowed !== false ||
              (s.currency ?? 'usd') !== currency ||
              (currency === 'sol' && s.quoteMint !== SOL_CANDLE_QUOTE),
          )
        )
          throw new Error('Candle context mismatch.');
        if (!c.signal.aborted) setSaved(data.observations);
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Saved candles unavailable.',
          );
      })
      .finally(() => {
        if (!c.signal.aborted) setBusy(false);
      });
    return () => pending.current?.abort();
  }, [
    project.id,
    project.revision,
    project.document.token.chain,
    project.document.token.address,
    currency,
  ]);
  const followContext = `${project.id}:${project.revision}:${pool}:${interval}:${currency}:${feedRunning}:${project.archived}`;
  const [follow, setFollow] = useState<{
    context: string;
    state: MarketFeedState;
  } | null>(null);
  const follower = useRef<ReturnType<typeof createForegroundMarketFeed> | null>(
    null,
  );
  const followState: MarketFeedState =
    follow?.context === followContext
      ? follow.state
      : { status: 'off', reason: '', reads: 0 };
  const refresh = useCallback(
    async (
      mode: 'latest' | 'older' | 'follow' = 'latest',
      feedSignal?: AbortSignal,
    ): Promise<boolean> => {
      if (feedRunning || project.archived) return false;
      const c = new AbortController();
      pending.current?.abort();
      pending.current = c;
      const signal = AbortSignal.any([
        c.signal,
        ...(feedSignal ? [feedSignal] : []),
        AbortSignal.timeout(20000),
      ]);
      setBusy(true);
      setError('');
      try {
        const response = await fetch('/api/imported-projects/candles', {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: project.id,
            revision: project.revision,
            pool,
            interval,
            mode,
            currency,
          }),
        });
        const data = (await response.json()) as Result;
        if (!response.ok)
          throw new Error(data.error || 'Candle provider unavailable.');
        if (signal.aborted) return false;
        accept(data);
        return true;
      } catch (e) {
        if (!c.signal.aborted && !feedSignal?.aborted)
          setError(e instanceof Error ? e.message : 'Candles unavailable.');
        return false;
      } finally {
        if (pending.current === c) setBusy(false);
      }
    },
    [
      feedRunning,
      project.archived,
      project.id,
      project.revision,
      pool,
      interval,
      accept,
      currency,
    ],
  );
  useEffect(() => {
    const controller = createForegroundMarketFeed({
      available: () =>
        !document.hidden &&
        navigator.onLine &&
        !project.archived &&
        !feedRunning,
      read: (signal) => refresh('follow', signal),
      onState: (state) => setFollow({ context: followContext, state }),
    });
    follower.current = controller;
    const hidden = () => {
      if (document.hidden) controller.pause('Tab hidden. Restart explicitly.');
    };
    const offline = () =>
      controller.pause('Browser offline. Restart explicitly.');
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('offline', offline);
    return () => {
      controller.destroy();
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('offline', offline);
      if (follower.current === controller) follower.current = null;
    };
  }, [refresh, followContext, project.archived, feedRunning]);
  const snapshot = saved.find(
    (s) =>
      s.pool === pool &&
      s.interval === interval &&
      (s.currency ?? 'usd') === currency,
  );
  return (
    <section aria-label="Selected pool candles">
      <h4>Pool candlesticks</h4>
      <div className="wallet-roster-actions">
        <label>
          Price currency{' '}
          <select
            aria-label="Candle price currency"
            value={currency}
            disabled={busy || followState.status === 'running'}
            onChange={(e) => setCurrency(e.target.value as CandleCurrency)}
          >
            <option value="usd">USD</option>
            {project.document.token.chain === 'Solana' &&
              project.document.token.address !== SOL_CANDLE_QUOTE && (
                <option value="sol">SOL (WSOL-quoted pools)</option>
              )}
          </select>
        </label>
        <label>
          Candle interval{' '}
          <select
            aria-label="Candle interval"
            value={interval}
            disabled={busy || followState.status === 'running'}
            onChange={(e) => setInterval(e.target.value as CandleInterval)}
          >
            {Object.keys(CANDLE_INTERVALS).map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          aria-label={
            busy ? 'Loading candles…' : 'Refresh candles for this pool'
          }
          title="Refresh pool candles"
          disabled={
            busy ||
            feedRunning ||
            project.archived ||
            followState.status === 'running'
          }
          onClick={() => void refresh()}
        >
          {busy ? 'Loading candles…' : 'Refresh candles'}
        </Button>
        <Button
          variant="outline"
          aria-label="Load older candles"
          title="Load older candles"
          disabled={
            busy ||
            feedRunning ||
            followState.status === 'running' ||
            project.archived ||
            !snapshot?.candles.length ||
            snapshot.olderExhausted ||
            snapshot.candles.length >= MAX_SAVED_CANDLES
          }
          onClick={() => void refresh('older')}
        >
          Older candles
        </Button>
        <Button
          variant="outline"
          aria-label={
            followState.status === 'running'
              ? 'Stop updates for pool candles'
              : 'Start updates for pool candles'
          }
          title={
            followState.status === 'running'
              ? 'Stop candle updates'
              : 'Start candle updates'
          }
          disabled={
            followState.status !== 'running' &&
            (busy || feedRunning || project.archived)
          }
          onClick={() =>
            followState.status === 'running'
              ? follower.current?.stop()
              : follower.current?.start()
          }
        >
          {followState.status === 'running' ? 'Stop updates' : 'Start updates'}
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {snapshot ? (
        <>
          {project.document.token.chain === 'Solana' ? (
            <ImportedChartTrades
              key={`${project.id}:${project.revision}:${pool}`}
              project={project}
              snapshot={snapshot}
            />
          ) : (
            <PoolCandleChart
              snapshot={snapshot}
              projectId={project.id}
              revision={project.revision}
              supplyToken={project.document.token}
            />
          )}
          <p>
            Observed {new Date(snapshot.observedAt).toLocaleString()} ·{' '}
            {snapshot.source} · captured project r{snapshot.projectRevision}
          </p>
          {snapshot.latestObservedAt && (
            <p>
              Latest-price candle page read{' '}
              {new Date(snapshot.latestObservedAt).toLocaleString()}. Loading
              older intervals does not refresh recent prices.
            </p>
          )}
          {snapshot.olderExhausted && (
            <p>
              The provider returned no older candles. This does not establish
              the pool&apos;s creation date or complete history.
            </p>
          )}
          {snapshot.candles.length >= MAX_SAVED_CANDLES && (
            <p>
              Saved history limit reached: 500 candles for this pool and
              interval.
            </p>
          )}
          {snapshot.projectRevision !== project.revision && (
            <p>
              Project metadata changed since this read. These candles remain
              historical provider observations for the saved token and pool.
            </p>
          )}
          <details className="candle-data-coverage">
            <summary>Candle data coverage</summary>
            <p>
              GeckoTerminal {currency.toUpperCase()} candles for this
              pool&apos;s base token. Read 100 intervals at a time and retain up
              to 500, with no invented gaps. Refresh latest replaces the saved
              history for this selection. Candle updates retain older loaded
              candles up to 500 and replace the refreshed time range. Stop the
              market feed before starting candle updates. Latest candle sets for
              up to 20 pool/interval selections are retained.
            </p>
            <output style={{ display: 'block' }}>
              Candle updates {followState.status}. {followState.reads}{' '}
              successful reads. {followState.reason} Refresh repeats 30 seconds
              after completion while visible and online. No background or tick
              stream.
            </output>
          </details>
        </>
      ) : (
        !busy && <p>No saved candles for this pool and interval.</p>
      )}
    </section>
  );
}
function ImportedChartTrades({
  project,
  snapshot,
}: {
  project: ImportedTokenProject;
  snapshot: PoolCandles;
}) {
  const [visible, setVisible] = useState(false),
    [rows, setRows] = useState<ImportedTradeReceipt[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [changed, setChanged] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const receiptEpoch = useRef(0);
  const visibleRef = useRef(false);
  const cursorRef = useRef<string | null>(null);
  const load = useCallback(
    async (mode: 'latest' | 'older' | 'follow' = 'latest') => {
      if (mode === 'follow') {
        if (!visibleRef.current) return;
        pending.current?.abort();
      } else if (pending.current) return;
      const c = new AbortController();
      const loadedEpoch = receiptEpoch.current;
      pending.current = c;
      setBusy(true);
      setError('');
      try {
        const response = await fetch(
          `/api/imported-projects/receipts?${new URLSearchParams({ projectId: project.id, ...(mode === 'older' && cursorRef.current ? { cursor: cursorRef.current } : {}) })}`,
          {
            cache: 'no-store',
            signal: AbortSignal.any([c.signal, AbortSignal.timeout(15000)]),
          },
        );
        const data = (await response.json()) as { error?: string };
        if (!response.ok)
          throw new Error(data.error || 'Recorded chart trades unavailable.');
        const page = importedTradePage(
          data,
          project.id,
          project.document.token.address,
          project.document.token.decimals,
        );
        if (c.signal.aborted) return;
        setRows((old) =>
          mode === 'latest'
            ? page.receipts
            : mode === 'older'
              ? [
                  ...old,
                  ...page.receipts.filter(
                    (r) => !old.some((o) => o.id === r.id),
                  ),
                ].slice(0, 500)
              : [
                  ...page.receipts,
                  ...old.filter(
                    (r) => !page.receipts.some((n) => n.id === r.id),
                  ),
                ].slice(0, 500),
        );
        if (mode !== 'follow') {
          cursorRef.current = page.nextCursor;
          setCursor(page.nextCursor);
          visibleRef.current = true;
          setVisible(true);
        }
        setChanged(receiptEpoch.current !== loadedEpoch);
      } catch (e) {
        if (!c.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Chart trades unavailable.',
          );
      } finally {
        if (pending.current === c) {
          pending.current = null;
          setBusy(false);
        }
      }
    },
    [
      project.id,
      project.document.token.address,
      project.document.token.decimals,
    ],
  );
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(
    () =>
      subscribeImportedReceiptSaved(
        { projectId: project.id, mint: project.document.token.address },
        () => {
          receiptEpoch.current++;
          setChanged(true);
          void load('follow');
        },
      ),
    [project.id, project.document.token.address, load],
  );
  const executionAverages = visible
    ? chartExecutionAverages(
        rows,
        project.id,
        project.document.token.address,
        project.document.token.decimals,
      )
    : undefined;
  const markers = visible
    ? chartTradeMarkers(
        snapshot,
        rows,
        project.id,
        project.document.token.decimals,
      )
    : undefined;
  const tradeControls = (
    <div className="wallet-roster-actions">
      <Button variant="outline" disabled={busy} onClick={() => void load()}>
        {busy
          ? 'Loading recorded trades…'
          : visible
            ? 'Reload recorded chart trades'
            : 'Show recorded trades on chart'}
      </Button>
      {visible && (
        <Button
          variant="outline"
          onClick={() => {
            visibleRef.current = false;
            pending.current?.abort();
            pending.current = null;
            setBusy(false);
            setVisible(false);
          }}
        >
          Hide trade markers
        </Button>
      )}
      {visible && cursor && rows.length < 500 && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void load('older')}
        >
          Load older chart trades
        </Button>
      )}
    </div>
  );
  return (
    <>
      {changed && (
        <output>
          A new trade finalized.{' '}
          {busy
            ? 'Refreshing recorded chart trades.'
            : 'Reload recorded chart trades to update the markers.'}
        </output>
      )}
      {error && <p role="alert">{error}</p>}
      <PoolCandleChart
        snapshot={snapshot}
        markers={markers}
        projectId={project.id}
        revision={project.revision}
        supplyToken={project.document.token}
        executionAverages={executionAverages}
      />
      {tradeControls}
      {markers && (
        <>
          <ChartExecutionAverages
            receipts={rows}
            projectId={project.id}
            mint={project.document.token.address}
            decimals={project.document.token.decimals}
            hasOlder={cursor !== null}
            chartCurrency={snapshot.currency ?? 'usd'}
          />
          <p>
            B: finalized buys. S: finalized sells. {markers.matched.length}{' '}
            trades mapped from {rows.length} loaded receipts.{' '}
            {markers.missingTime} have no block time; {markers.outsideCandles}{' '}
            fall outside available candle intervals.
          </p>
          <p>
            Markers use transaction block time and sit below its candle. They
            show this token&apos;s recorded trades across routes, not execution
            prices or proof of a trade in this selected pool.
          </p>
          <details>
            <summary>Recorded chart trades</summary>
            {markers.matched.map((r) => (
              <p key={r.id}>
                <a
                  href={`https://explorer.solana.com/tx/${encodeURIComponent(r.document.signature)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {r.document.side}{' '}
                  {formatNativeBalance(
                    r.document.tokenUnitsRaw,
                    r.document.decimals,
                  )}{' '}
                  {project.document.token.symbol}
                </a>{' '}
                · {new Date(r.document.blockTime! * 1000).toLocaleString()} ·{' '}
                <code>{r.document.wallet}</code>
              </p>
            ))}
          </details>
        </>
      )}
    </>
  );
}
