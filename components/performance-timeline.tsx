'use client';
import { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Pie,
  PieChart,
  Rectangle,
  ResponsiveContainer,
  Sector,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
  type PieSectorShapeProps,
} from 'recharts';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { signedBalanceAmount } from '@/lib/wallet-balance-format';
import {
  TIMEFRAMES,
  axisSol,
  buildTimeline,
  calendarMonth,
  dailyResults,
  initialCalendarMonth,
  isValidTimeZone,
  positiveStreaks,
  windowChange,
  winRate,
  zonedParts,
  type CalendarDay,
  type PerformanceTimelineData,
  type RealizedSale,
  type Timeframe,
  type TimelineBucket,
} from '@/lib/performance-timeline';

const GAIN = '#4FA671',
  LOSS = '#ED5B5E',
  MUTED = '#9ca7bd',
  GRID = '#343846';
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const sol = (lamports: bigint | string) =>
  `${signedBalanceAmount(lamports.toString(), 9)} SOL`;
const tone = (lamports: bigint) =>
  lamports > 0n
    ? 'text-[#4FA671]'
    : lamports < 0n
      ? 'text-[#ED5B5E]'
      : 'text-muted-foreground';
// Plotting needs numbers; every displayed value stays exact.
const plotted = (lamports: bigint) => Number(lamports) / 1e9;

/** Per-viewer convenience only: unavailable storage falls back to the default. */
function useStoredChoice<T extends string>(
  key: string,
  fallback: T,
  accept: (value: string) => boolean,
) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = globalThis.localStorage?.getItem(key);
      return stored && accept(stored) ? (stored as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const update = (next: T) => {
    setValue(next);
    try {
      globalThis.localStorage?.setItem(key, next);
    } catch {
      /* storage unavailable */
    }
  };
  return [value, update] as const;
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="m-0 inline-flex min-w-0 rounded-md border border-[#343846] p-0.5">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`min-h-9 whitespace-nowrap rounded px-3 text-sm ${
            value === o.value
              ? 'bg-[#7892ff] text-[#101222]'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

function BucketTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: TimelineBucket }>;
}) {
  if (!active || !payload?.length) return null;
  const b = payload[0].payload;
  return (
    <div className="rounded-md border border-[#343846] bg-[#151720] px-3 py-2 text-xs">
      <p className="font-medium">{b.title}</p>
      <p>
        Period:{' '}
        <span className={tone(b.resultLamports)}>{sol(b.resultLamports)}</span>
      </p>
      <p>
        Cumulative:{' '}
        <span className={tone(b.cumulativeLamports)}>
          {sol(b.cumulativeLamports)}
        </span>
      </p>
      <p className="text-muted-foreground">
        {b.saleCount} sale{b.saleCount === 1 ? '' : 's'}
      </p>
    </div>
  );
}

const CHARTS = [
  { value: 'cumulative', label: 'Cumulative' },
  { value: 'period', label: 'Per period' },
  { value: 'winRate', label: 'Win rate' },
] as const;
type ChartKind = (typeof CHARTS)[number]['value'];
const WIN_MODES = [
  { value: 'count', label: 'By count' },
  { value: 'result', label: 'By result' },
] as const;

function zoneOptions(current: string) {
  let zones: string[] = [];
  try {
    zones =
      (
        Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
      ).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    zones = [];
  }
  return zones.includes(current) ? zones : [current, ...zones];
}

export function PerformanceTimeline({
  data,
  nowSeconds,
}: {
  data: PerformanceTimelineData;
  /** Fixed clock for tests; defaults to the snapshot time. */
  nowSeconds?: number;
}) {
  const now = nowSeconds ?? Math.floor(Date.parse(data.observedAt) / 1000);
  const localZone =
    new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const [timeframe, setTimeframe] = useStoredChoice<Timeframe>(
    'bundle-performance-timeframe',
    'all',
    (v) => TIMEFRAMES.some((t) => t.value === v),
  );
  const [timeZone, setTimeZone] = useStoredChoice<string>(
    'bundle-performance-timezone',
    localZone,
    isValidTimeZone,
  );
  const [chart, setChart] = useStoredChoice<ChartKind>(
    'bundle-performance-chart',
    'cumulative',
    (v) => CHARTS.some((c) => c.value === v),
  );
  const [winMode, setWinMode] = useState<'count' | 'result'>('count');
  const timeline = useMemo(
    () => buildTimeline(data.sales, timeframe, timeZone, now),
    [data.sales, timeframe, timeZone, now],
  );
  const change = timeline.previous
    ? windowChange(timeline.totalLamports, timeline.previous.totalLamports)
    : null;
  const rate = winRate(timeline, winMode);
  const chartData = timeline.buckets.map((b) => ({
    ...b,
    period: plotted(b.resultLamports),
    cumulative: plotted(b.cumulativeLamports),
  }));
  const zones = useMemo(() => zoneOptions(timeZone), [timeZone]);
  const timeframeLabel =
    TIMEFRAMES.find((t) => t.value === timeframe)?.label ?? 'All';

  return (
    <section
      aria-label="Realized results over time"
      className="mt-6 flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Segmented
          label="Timeframe"
          options={TIMEFRAMES}
          value={timeframe}
          onChange={setTimeframe}
        />
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Time zone
          <select
            className="min-h-9 max-w-64 rounded-md border border-[#343846] bg-[#151720] px-2 text-sm text-foreground"
            value={timeZone}
            onChange={(e) => setTimeZone(e.target.value)}
          >
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
                {z === localZone ? ' (local)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="dashboard-stats">
        <article>
          <span>Realized result · {timeframeLabel}</span>
          <strong className={tone(timeline.totalLamports)}>
            {timeline.sales.length ? sol(timeline.totalLamports) : '—'}
          </strong>
          <small>
            {timeline.sales.length} linked sale
            {timeline.sales.length === 1 ? '' : 's'} in this period
          </small>
        </article>
        <article>
          <span>
            {change
              ? `Versus previous ${timeframeLabel}`
              : 'Versus previous period'}
          </span>
          <strong>
            {change
              ? `${signedBalanceAmount(change.deltaLamports.toString(), 9)} SOL`
              : '—'}
          </strong>
          <small>
            {!change
              ? 'All-time view has no earlier period'
              : change.percent === null
                ? `Previous: ${sol(timeline.previous!.totalLamports)}. No percentage: zero base or sign change.`
                : `${change.percent >= 0 ? '+' : ''}${change.percent.toFixed(Math.abs(change.percent) >= 100 ? 0 : 1)}% vs ${sol(timeline.previous!.totalLamports)}`}
          </small>
        </article>
        <article>
          <span>Win rate</span>
          <strong>{rate === null ? '—' : `${Math.round(rate)}%`}</strong>
          <small>
            {timeline.wins} wins · {timeline.losses} losses
            {timeline.breakEven ? ` · ${timeline.breakEven} break-even` : ''}
          </small>
        </article>
        <article>
          {/* .dashboard-stats styles every span as a label, so values avoid spans. */}
          <span>Gross gains / losses</span>
          <strong className="text-[#4FA671]">
            {sol(timeline.profitLamports)}
          </strong>
          <small className="text-[#ED5B5E]">
            Losses: {sol(-timeline.lossLamports)}
          </small>
        </article>
      </div>

      <div className="rounded-lg border border-[#343846] p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium">
            {chart === 'cumulative'
              ? 'Cumulative realized result'
              : chart === 'period'
                ? `Result per ${timeline.granularity}`
                : 'Win rate'}
          </h3>
          <div className="flex flex-wrap gap-2">
            {chart === 'winRate' && (
              <Segmented
                label="Win rate basis"
                options={WIN_MODES}
                value={winMode}
                onChange={setWinMode}
              />
            )}
            <Segmented
              label="Chart"
              options={CHARTS}
              value={chart}
              onChange={setChart}
            />
          </div>
        </div>
        {!timeline.sales.length ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No linked sales in this period.
          </p>
        ) : chart === 'winRate' ? (
          <WinRateDonut
            wins={
              winMode === 'count'
                ? timeline.wins
                : plotted(timeline.profitLamports)
            }
            losses={
              winMode === 'count'
                ? timeline.losses
                : plotted(timeline.lossLamports)
            }
            rate={rate}
            labels={
              winMode === 'count'
                ? [`${timeline.wins} wins`, `${timeline.losses} losses`]
                : [sol(timeline.profitLamports), sol(-timeline.lossLamports)]
            }
          />
        ) : (
          <div className="h-64 w-full" aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              {chart === 'cumulative' ? (
                <AreaChart data={chartData} margin={{ left: 0, right: 8 }}>
                  <CartesianGrid vertical={false} stroke={GRID} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: MUTED, fontSize: 12 }}
                    tickLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    width={72}
                    tick={{ fill: MUTED, fontSize: 12 }}
                    tickLine={false}
                    tickFormatter={axisSol}
                  />
                  <Tooltip content={<BucketTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="cumulative"
                    stroke={timeline.totalLamports < 0n ? LOSS : GAIN}
                    fill={timeline.totalLamports < 0n ? LOSS : GAIN}
                    fillOpacity={0.15}
                  />
                </AreaChart>
              ) : (
                <BarChart data={chartData} margin={{ left: 0, right: 8 }}>
                  <CartesianGrid vertical={false} stroke={GRID} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: MUTED, fontSize: 12 }}
                    tickLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    width={72}
                    tick={{ fill: MUTED, fontSize: 12 }}
                    tickLine={false}
                    tickFormatter={axisSol}
                  />
                  <Tooltip content={<BucketTooltip />} />
                  <Bar
                    dataKey="period"
                    shape={(props: BarShapeProps) => (
                      <Rectangle
                        x={props.x}
                        y={props.y}
                        width={props.width}
                        height={props.height}
                        radius={3}
                        fill={
                          (props.payload as TimelineBucket).resultLamports < 0n
                            ? LOSS
                            : GAIN
                        }
                      />
                    )}
                  />
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        )}
        {timeline.sales.length > 0 && (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Show chart data as a table
            </summary>
            <div className="project-table-wrap mt-2">
              <table className="project-table">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Result</th>
                    <th>Cumulative</th>
                    <th>Sales</th>
                  </tr>
                </thead>
                <tbody>
                  {timeline.buckets
                    .filter((b) => b.saleCount > 0)
                    .map((b) => (
                      <tr key={b.key}>
                        <td>{b.title}</td>
                        <td className={tone(b.resultLamports)}>
                          {sol(b.resultLamports)}
                        </td>
                        <td>{sol(b.cumulativeLamports)}</td>
                        <td>{b.saleCount}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>

      <PerformanceCalendar
        sales={data.sales}
        timeZone={timeZone}
        nowSeconds={now}
      />

      <p className="text-xs text-muted-foreground">
        Results are placed on each sale&apos;s on-chain finalization time in{' '}
        {timeZone.replace(/_/g, ' ')}, using exact recorded lamports.{' '}
        {timeline.untimedSaleCount > 0 &&
          `${timeline.untimedSaleCount} sale${timeline.untimedSaleCount === 1 ? '' : 's'} without a reported block time ${timeline.untimedSaleCount === 1 ? 'is' : 'are'} excluded from time views. `}
        {data.unlinkedSaleCount > 0 &&
          `${data.unlinkedSaleCount} sale${data.unlinkedSaleCount === 1 ? '' : 's'} without linked buys ${data.unlinkedSaleCount === 1 ? 'is' : 'are'} excluded, not counted as profit. `}
        Open positions, unrealized value and failed-execution fees are not
        included. Comparisons use the immediately preceding period of the same
        length.
      </p>
    </section>
  );
}

function WinRateDonut({
  wins,
  losses,
  rate,
  labels,
}: {
  wins: number;
  losses: number;
  rate: number | null;
  labels: [string, string];
}) {
  const slices = [
    { name: 'Wins', value: wins, color: GAIN },
    { name: 'Losses', value: losses, color: LOSS },
  ];
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative h-48 w-48" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices.filter((s) => s.value > 0)}
              dataKey="value"
              innerRadius="60%"
              outerRadius="85%"
              paddingAngle={2}
              stroke="none"
              shape={(props: PieSectorShapeProps) => (
                <Sector
                  cx={props.cx}
                  cy={props.cy}
                  innerRadius={props.innerRadius}
                  outerRadius={props.outerRadius}
                  startAngle={props.startAngle}
                  endAngle={props.endAngle}
                  fill={(props.payload as { color: string }).color}
                />
              )}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold">
            {rate === null ? '—' : `${Math.round(rate)}%`}
          </span>
          <span className="text-xs text-muted-foreground">Win rate</span>
        </div>
      </div>
      <ul className="flex flex-col gap-2 text-sm">
        <li>
          <span className="mr-2 inline-block size-2.5 rounded-full bg-[#4FA671]" />
          Wins: {labels[0]}
        </li>
        <li>
          <span className="mr-2 inline-block size-2.5 rounded-full bg-[#ED5B5E]" />
          Losses: {labels[1]}
        </li>
      </ul>
    </div>
  );
}

function saleTime(sale: RealizedSale, timeZone: string) {
  return sale.blockTime === null
    ? 'Time unavailable'
    : new Date(sale.blockTime * 1000).toLocaleTimeString('en-US', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
      });
}

export function PerformanceCalendar({
  sales,
  timeZone,
  nowSeconds,
}: {
  sales: RealizedSale[];
  timeZone: string;
  nowSeconds: number;
}) {
  const days = useMemo(() => dailyResults(sales, timeZone), [sales, timeZone]);
  const today = zonedParts(nowSeconds, timeZone);
  const earliest = [...days.keys()].sort()[0];
  const [view, setView] = useState(() => initialCalendarMonth(days, today));
  const [selected, setSelected] = useState<CalendarDay | null>(null);
  const month = calendarMonth(days, view.year, view.month);
  const monthKey = `${view.year}-${String(view.month).padStart(2, '0')}`;
  const streaks = positiveStreaks(days, `${monthKey}-01`, `${monthKey}-31`);
  const canBack = earliest !== undefined && `${monthKey}-01` > earliest;
  const canForward =
    view.year < today.year ||
    (view.year === today.year && view.month < today.month);
  const shift = (delta: number) => {
    const index = view.year * 12 + view.month - 1 + delta;
    setView({ year: Math.floor(index / 12), month: (index % 12) + 1 });
    setSelected(null);
  };
  return (
    <div className="rounded-lg border border-[#343846] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Results calendar</h3>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            aria-label="Previous month"
            disabled={!canBack}
            onClick={() => shift(-1)}
          >
            <ChevronLeft />
          </Button>
          <span className="min-w-36 text-center text-sm" aria-live="polite">
            {MONTH_NAMES[view.month - 1]} {view.year}
          </span>
          <Button
            variant="outline"
            aria-label="Next month"
            disabled={!canForward}
            onClick={() => shift(1)}
          >
            <ChevronRight />
          </Button>
        </div>
        <span className={`text-sm ${tone(month.totalLamports)}`}>
          {month.saleCount ? sol(month.totalLamports) : 'No sales this month'}
        </span>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {month.cells.map((cell, i) =>
          cell === null ? (
            <span key={`blank-${i}`} />
          ) : (
            <button
              key={cell.key}
              type="button"
              disabled={!cell.sales.length}
              aria-pressed={selected?.key === cell.key}
              aria-label={
                cell.sales.length
                  ? `${MONTH_NAMES[view.month - 1]} ${cell.day}: ${sol(cell.resultLamports)}, ${cell.sales.length} sale${cell.sales.length === 1 ? '' : 's'}`
                  : `${MONTH_NAMES[view.month - 1]} ${cell.day}: no sales`
              }
              onClick={() =>
                setSelected(selected?.key === cell.key ? null : cell)
              }
              className={`flex min-h-14 flex-col items-start rounded-md border p-1.5 text-left text-xs disabled:opacity-60 ${
                selected?.key === cell.key
                  ? 'border-[#7892ff]'
                  : 'border-[#343846]'
              } ${
                cell.resultLamports > 0n
                  ? 'bg-[#4FA671]/10'
                  : cell.resultLamports < 0n
                    ? 'bg-[#ED5B5E]/10'
                    : ''
              }`}
            >
              <span className="text-muted-foreground">{cell.day}</span>
              {cell.sales.length > 0 && (
                <span className={`truncate ${tone(cell.resultLamports)}`}>
                  {signedBalanceAmount(cell.resultLamports.toString(), 9)}
                </span>
              )}
            </button>
          ),
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Current positive streak: {streaks.current} trading day
        {streaks.current === 1 ? '' : 's'} · Best in{' '}
        {MONTH_NAMES[view.month - 1]}: {streaks.best} trading day
        {streaks.best === 1 ? '' : 's'}. Days without sales do not break a
        streak.
      </p>
      {selected && (
        <div className="project-table-wrap mt-3">
          <table className="project-table">
            <caption>
              Sales on {MONTH_NAMES[view.month - 1]} {selected.day}, {view.year}
              : {sol(selected.resultLamports)}
            </caption>
            <thead>
              <tr>
                <th>Time</th>
                <th>Project or plan</th>
                <th>Wallet</th>
                <th>Result</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {selected.sales.map((s) => (
                <tr key={s.saleId}>
                  <td>{saleTime(s, timeZone)}</td>
                  <td>
                    {s.scopeName}
                    <small>{s.kind}</small>
                  </td>
                  <td>
                    <code className="warmup-address">
                      {s.wallet.slice(0, 4)}…{s.wallet.slice(-4)}
                    </code>
                  </td>
                  <td className={tone(BigInt(s.resultLamports))}>
                    {sol(s.resultLamports)}
                  </td>
                  <td>
                    <a
                      href={`https://solscan.io/tx/${s.signature}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
