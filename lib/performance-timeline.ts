import {
  ACCOUNT_PERFORMANCE_LIMIT,
  type AccountPerformance,
} from './account-performance';

/** One finalized sale with its exact linked result. Sums reconcile to the account summary. */
export type RealizedSale = {
  kind: 'Imported trades' | 'Warmup';
  scopeId: string;
  scopeName: string;
  saleId: string;
  signature: string;
  wallet: string;
  slot: number;
  /** On-chain block time in seconds; null when the provider did not report it. */
  blockTime: number | null;
  costLamports: string;
  netProceedsLamports: string;
  resultLamports: string;
};
export type PerformanceTimelineData = {
  observedAt: string;
  sales: RealizedSale[];
  /** Sales without a complete acquisition link; excluded from every time view. */
  unlinkedSaleCount: number;
};

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SIGNED = /^(0|-?[1-9]\d{0,24})$/;
const UNSIGNED = /^(0|[1-9]\d{0,24})$/;

/** Validates timeline evidence and requires it to reconcile exactly with the summary from the same snapshot. */
export function validatedTimelineData(
  value: unknown,
  summary: AccountPerformance,
): PerformanceTimelineData {
  const v = value as PerformanceTimelineData;
  if (
    !v ||
    v.observedAt !== summary.observedAt ||
    !Array.isArray(v.sales) ||
    v.sales.length > ACCOUNT_PERFORMANCE_LIMIT ||
    v.unlinkedSaleCount !== summary.unlinkedSaleCount
  )
    throw new Error('Performance timeline unavailable.');
  const ids = new Set<string>();
  let total = 0n;
  for (const s of v.sales) {
    if (
      !s ||
      !['Imported trades', 'Warmup'].includes(s.kind) ||
      !UUID.test(s.scopeId) ||
      typeof s.scopeName !== 'string' ||
      typeof s.saleId !== 'string' ||
      !s.saleId ||
      ids.has(s.saleId) ||
      typeof s.signature !== 'string' ||
      !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s.signature) ||
      typeof s.wallet !== 'string' ||
      !Number.isSafeInteger(s.slot) ||
      s.slot < 1 ||
      (s.blockTime !== null &&
        (!Number.isSafeInteger(s.blockTime) || s.blockTime < 0)) ||
      !UNSIGNED.test(s.costLamports) ||
      !SIGNED.test(s.netProceedsLamports) ||
      !SIGNED.test(s.resultLamports) ||
      BigInt(s.netProceedsLamports) - BigInt(s.costLamports) !==
        BigInt(s.resultLamports)
    )
      throw new Error('Performance timeline sale differs.');
    ids.add(s.saleId);
    total += BigInt(s.resultLamports);
  }
  if (
    v.sales.length !== summary.linkedSaleCount ||
    total.toString() !== summary.linkedResultLamports
  )
    throw new Error('Performance timeline does not match recorded totals.');
  return v;
}

export type Timeframe = '1d' | '1w' | '1m' | '1y' | 'all';
export type Granularity = 'hour' | 'day' | 'month';
export const TIMEFRAMES: ReadonlyArray<{ value: Timeframe; label: string }> = [
  { value: '1d', label: '1D' },
  { value: '1w', label: '7D' },
  { value: '1m', label: '30D' },
  { value: '1y', label: '1Y' },
  { value: 'all', label: 'All' },
];
const DURATION: Record<Exclude<Timeframe, 'all'>, number> = {
  '1d': 86_400,
  '1w': 7 * 86_400,
  '1m': 30 * 86_400,
  '1y': 365 * 86_400,
};
/** All-time adapts to the recorded span so short histories are not one or two points. */
export function timeframeGranularity(
  t: Timeframe,
  spanSeconds = Infinity,
): Granularity {
  if (t === 'all')
    return spanSeconds <= 2 * 86_400
      ? 'hour'
      : spanSeconds <= 180 * 86_400
        ? 'day'
        : 'month';
  return t === '1d' ? 'hour' : t === '1w' || t === '1m' ? 'day' : 'month';
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}
/** Calendar parts of an instant in the selected IANA time zone. */
export function zonedParts(epochSeconds: number, timeZone: string) {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(epochSeconds * 1000))
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
  };
}
export function isValidTimeZone(timeZone: string) {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}
const pad = (n: number) => String(n).padStart(2, '0');
export function dayKey(p: { year: number; month: number; day: number }) {
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
function bucketKey(epochSeconds: number, g: Granularity, timeZone: string) {
  const p = zonedParts(epochSeconds, timeZone);
  return g === 'month'
    ? `${p.year}-${pad(p.month)}`
    : g === 'day'
      ? dayKey(p)
      : `${dayKey(p)}T${pad(p.hour)}`;
}
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
export function bucketLabel(key: string, g: Granularity) {
  const [date, hour] = key.split('T');
  const [year, month, day] = date.split('-').map(Number);
  if (g === 'hour') return `${hour}:00`;
  if (g === 'day') return `${MONTHS[month - 1]} ${day}`;
  return `${MONTHS[month - 1]} ${year}`;
}
/** Unambiguous period name: a 1D window repeats hour labels across two dates. */
export function bucketTitle(key: string, g: Granularity) {
  const [date, hour] = key.split('T');
  const [year, month, day] = date.split('-').map(Number);
  if (g === 'month') return `${MONTHS[month - 1]} ${year}`;
  const name = `${MONTHS[month - 1]} ${day}, ${year}`;
  return g === 'hour' ? `${name}, ${hour}:00–${hour}:59` : name;
}
/** Axis ticks are approximate; trims floating-point noise like 0.30000000000000004. */
export function axisSol(value: number) {
  if (!Number.isFinite(value)) return '';
  const text = Number(value.toPrecision(4)).toString();
  return `${text === '-0' ? '0' : text} SOL`;
}

export type TimelineBucket = {
  key: string;
  label: string;
  title: string;
  resultLamports: bigint;
  cumulativeLamports: bigint;
  saleCount: number;
};
export type Timeline = {
  timeframe: Timeframe;
  granularity: Granularity;
  buckets: TimelineBucket[];
  sales: RealizedSale[];
  totalLamports: bigint;
  profitLamports: bigint;
  lossLamports: bigint;
  wins: number;
  losses: number;
  breakEven: number;
  /** Same-length window immediately before this one; null for All. */
  previous: { totalLamports: bigint; saleCount: number } | null;
  untimedSaleCount: number;
};

/** Buckets exact results by sale finalization time in the selected time zone. */
export function buildTimeline(
  allSales: RealizedSale[],
  timeframe: Timeframe,
  timeZone: string,
  nowSeconds: number,
): Timeline {
  const timed = allSales
    .filter((s) => s.blockTime !== null)
    .sort((a, b) => a.blockTime! - b.blockTime! || a.slot - b.slot);
  const start =
    timeframe === 'all'
      ? (timed[0]?.blockTime ?? nowSeconds)
      : nowSeconds - DURATION[timeframe];
  const granularity = timeframeGranularity(timeframe, nowSeconds - start);
  const sales = timed.filter(
    (s) => s.blockTime! >= start && s.blockTime! <= nowSeconds,
  );
  const previous =
    timeframe === 'all'
      ? null
      : timed
          .filter(
            (s) =>
              s.blockTime! >= start - DURATION[timeframe] &&
              s.blockTime! < start,
          )
          .reduce(
            (p, s) => ({
              totalLamports: p.totalLamports + BigInt(s.resultLamports),
              saleCount: p.saleCount + 1,
            }),
            { totalLamports: 0n, saleCount: 0 },
          );
  const buckets: TimelineBucket[] = [];
  const index = new Map<string, TimelineBucket>();
  if (timeframe !== 'all' || sales.length) {
    // Step below the shortest bucket so every local hour, day or month in range appears once.
    const step = granularity === 'month' ? 86_400 : 3_600;
    for (let t = start; ; t = Math.min(t + step, nowSeconds)) {
      const key = bucketKey(t, granularity, timeZone);
      if (!index.has(key)) {
        const bucket = {
          key,
          label: bucketLabel(key, granularity),
          title: bucketTitle(key, granularity),
          resultLamports: 0n,
          cumulativeLamports: 0n,
          saleCount: 0,
        };
        index.set(key, bucket);
        buckets.push(bucket);
      }
      if (t >= nowSeconds) break;
    }
  }
  let total = 0n,
    profit = 0n,
    loss = 0n,
    wins = 0,
    losses = 0,
    breakEven = 0;
  for (const s of sales) {
    const result = BigInt(s.resultLamports);
    const bucket = index.get(bucketKey(s.blockTime!, granularity, timeZone))!;
    bucket.resultLamports += result;
    bucket.saleCount++;
    total += result;
    if (result > 0n) {
      wins++;
      profit += result;
    } else if (result < 0n) {
      losses++;
      loss -= result;
    } else breakEven++;
  }
  let running = 0n;
  for (const b of buckets) {
    running += b.resultLamports;
    b.cumulativeLamports = running;
  }
  return {
    timeframe,
    granularity,
    buckets,
    sales,
    totalLamports: total,
    profitLamports: profit,
    lossLamports: loss,
    wins,
    losses,
    breakEven,
    previous,
    untimedSaleCount: allSales.length - timed.length,
  };
}

/**
 * Change against the previous equal window. The percentage is withheld when the
 * base is zero or the result changed sign, where a ratio would mislead.
 */
export function windowChange(current: bigint, previous: bigint) {
  const delta = current - previous;
  const percent =
    previous === 0n || (current !== 0n && current > 0n !== previous > 0n)
      ? null
      : (Number(delta) / Math.abs(Number(previous))) * 100;
  return { deltaLamports: delta, percent };
}

/** Win share by count (break-even excluded) or by result magnitude. */
export function winRate(t: Timeline, mode: 'count' | 'result') {
  if (mode === 'count')
    return t.wins + t.losses ? (t.wins / (t.wins + t.losses)) * 100 : null;
  const whole = t.profitLamports + t.lossLamports;
  return whole ? (Number(t.profitLamports) / Number(whole)) * 100 : null;
}

export type CalendarDay = {
  key: string;
  day: number;
  resultLamports: bigint;
  sales: RealizedSale[];
};
/** Day-level results for the selected time zone, keyed YYYY-MM-DD. */
export function dailyResults(sales: RealizedSale[], timeZone: string) {
  const days = new Map<string, CalendarDay>();
  for (const s of sales) {
    if (s.blockTime === null) continue;
    const p = zonedParts(s.blockTime, timeZone);
    const key = dayKey(p);
    const day = days.get(key) ?? {
      key,
      day: p.day,
      resultLamports: 0n,
      sales: [],
    };
    day.resultLamports += BigInt(s.resultLamports);
    day.sales.push(s);
    days.set(key, day);
  }
  return days;
}
/** Month grid starting Monday; null cells pad the first week. */
export function calendarMonth(
  days: Map<string, CalendarDay>,
  year: number,
  month: number,
) {
  const first = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: Array<CalendarDay | null> = Array(first).fill(null);
  let total = 0n,
    saleCount = 0;
  for (let day = 1; day <= length; day++) {
    const key = dayKey({ year, month, day });
    const found = days.get(key) ?? { key, day, resultLamports: 0n, sales: [] };
    total += found.resultLamports;
    saleCount += found.sales.length;
    cells.push(found);
  }
  return { cells, totalLamports: total, saleCount };
}
/**
 * Streaks count consecutive trading days (days with at least one sale) whose
 * result was positive. Days without sales neither extend nor break a streak.
 */
export function positiveStreaks(
  days: Map<string, CalendarDay>,
  rangeStart: string,
  rangeEnd: string,
) {
  const ordered = [...days.values()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  let current = 0;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i].resultLamports > 0n) current++;
    else break;
  }
  let best = 0,
    run = 0;
  for (const d of ordered) {
    if (d.key < rangeStart || d.key > rangeEnd) continue;
    run = d.resultLamports > 0n ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return { current, best };
}
/** Month the calendar opens on: the latest month with sales up to today, else today. */
export function initialCalendarMonth(
  days: Map<string, CalendarDay>,
  today: { year: number; month: number; day: number },
) {
  const todayKey = dayKey(today);
  const latest = [...days.keys()]
    .filter((k) => k <= todayKey)
    .sort()
    .pop();
  if (!latest) return { year: today.year, month: today.month };
  const [year, month] = latest.split('-').map(Number);
  return { year, month };
}
