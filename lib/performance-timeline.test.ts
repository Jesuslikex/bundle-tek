import { describe, expect, it } from 'vitest';
import {
  axisSol,
  bucketTitle,
  buildTimeline,
  calendarMonth,
  dailyResults,
  initialCalendarMonth,
  positiveStreaks,
  validatedTimelineData,
  windowChange,
  winRate,
  type RealizedSale,
} from './performance-timeline';
import type { AccountPerformance } from './account-performance';

const scopeId = '00000000-0000-4000-8000-000000000001';
let n = 0;
function sale(
  resultLamports: string,
  blockTime: number | null,
  overrides: Partial<RealizedSale> = {},
): RealizedSale {
  n++;
  const result = BigInt(resultLamports);
  return {
    kind: 'Imported trades',
    scopeId,
    scopeName: 'Project',
    saleId: `sale-${n}`,
    signature: '5'.repeat(87),
    wallet: 'Wallet1111111111111111111111111111111111111',
    slot: n,
    blockTime,
    costLamports: '1000',
    netProceedsLamports: (1000n + result).toString(),
    resultLamports,
    ...overrides,
  };
}
// 2026-10-12T12:00:00Z
const NOW = Date.UTC(2026, 9, 12, 12) / 1000;
const HOUR = 3600,
  DAY = 86_400;

describe('buildTimeline', () => {
  it('places results on the finalization day of the selected time zone', () => {
    // 2026-10-10T23:30Z is Oct 11 01:30 in Berlin (UTC+2) and Oct 10 in New York.
    const late = Date.UTC(2026, 9, 10, 23, 30) / 1000;
    const sales = [sale('500', late)];
    const berlin = buildTimeline(sales, '1w', 'Europe/Berlin', NOW);
    const newYork = buildTimeline(sales, '1w', 'America/New_York', NOW);
    expect(berlin.buckets.find((b) => b.saleCount)?.key).toBe('2026-10-11');
    expect(newYork.buckets.find((b) => b.saleCount)?.key).toBe('2026-10-10');
    expect(berlin.granularity).toBe('day');
  });

  it('uses hourly buckets for one day and keeps every hour in range', () => {
    const t = buildTimeline([sale('1', NOW - 2 * HOUR)], '1d', 'UTC', NOW);
    expect(t.granularity).toBe('hour');
    expect(t.buckets).toHaveLength(25);
    expect(t.buckets.find((b) => b.saleCount)?.label).toBe('10:00');
  });

  it('sums exactly beyond floating-point precision and accumulates in order', () => {
    const big = '9007199254740993'; // 2^53 + 1
    const t = buildTimeline(
      [sale(big, NOW - 3 * DAY), sale('-1', NOW - DAY), sale('2', NOW - DAY)],
      '1w',
      'UTC',
      NOW,
    );
    expect(t.totalLamports).toBe(9007199254740994n);
    expect(t.buckets.at(-1)!.cumulativeLamports).toBe(9007199254740994n);
    expect(t.profitLamports).toBe(9007199254740995n);
    expect(t.lossLamports).toBe(1n);
  });

  it('compares with the immediately preceding window of equal length only', () => {
    const t = buildTimeline(
      [
        sale('300', NOW - 2 * DAY),
        sale('100', NOW - 9 * DAY),
        sale('9999', NOW - 40 * DAY),
      ],
      '1w',
      'UTC',
      NOW,
    );
    expect(t.totalLamports).toBe(300n);
    expect(t.previous).toEqual({ totalLamports: 100n, saleCount: 1 });
    expect(buildTimeline([], 'all', 'UTC', NOW).previous).toBeNull();
  });

  it('excludes and counts sales without a block time', () => {
    const t = buildTimeline(
      [sale('5', null), sale('7', NOW - HOUR)],
      'all',
      'UTC',
      NOW,
    );
    expect(t.untimedSaleCount).toBe(1);
    expect(t.totalLamports).toBe(7n);
  });

  it('sizes all-time buckets to the recorded span instead of collapsing short histories', () => {
    const all = (agoSeconds: number) =>
      buildTimeline([sale('1', NOW - agoSeconds)], 'all', 'UTC', NOW);
    expect(all(HOUR).granularity).toBe('hour');
    const daily = all(40 * DAY);
    expect(daily.granularity).toBe('day');
    expect(daily.buckets).toHaveLength(41);
    const monthly = all(400 * DAY);
    expect(monthly.granularity).toBe('month');
    expect(monthly.buckets[0].label).toBe('Sep 2025');
  });
});

describe('windowChange and winRate', () => {
  it('withholds percentages for a zero base or a sign change', () => {
    expect(windowChange(150n, 100n)).toEqual({
      deltaLamports: 50n,
      percent: 50,
    });
    expect(windowChange(-50n, -100n).percent).toBe(50);
    expect(windowChange(100n, 0n).percent).toBeNull();
    expect(windowChange(100n, -100n)).toEqual({
      deltaLamports: 200n,
      percent: null,
    });
    expect(windowChange(0n, 100n).percent).toBe(-100);
  });

  it('excludes break-even from count win rate and weighs result mode by magnitude', () => {
    const t = buildTimeline(
      [
        sale('300', NOW - HOUR),
        sale('-100', NOW - HOUR),
        sale('0', NOW - HOUR),
      ],
      '1d',
      'UTC',
      NOW,
    );
    expect([t.wins, t.losses, t.breakEven]).toEqual([1, 1, 1]);
    expect(winRate(t, 'count')).toBe(50);
    expect(winRate(t, 'result')).toBe(75);
    expect(winRate(buildTimeline([], '1d', 'UTC', NOW), 'count')).toBeNull();
  });
});

describe('calendar', () => {
  it('builds a Monday-first month with exact daily totals', () => {
    const days = dailyResults(
      [
        sale('10', Date.UTC(2026, 9, 1, 9) / 1000),
        sale('-4', Date.UTC(2026, 9, 1, 15) / 1000),
      ],
      'UTC',
    );
    const month = calendarMonth(days, 2026, 10);
    // October 1, 2026 is a Thursday: three leading blanks.
    expect(month.cells.slice(0, 3)).toEqual([null, null, null]);
    expect(month.cells[3]).toMatchObject({ day: 1, resultLamports: 6n });
    expect(month.cells).toHaveLength(3 + 31);
    expect(month).toMatchObject({ totalLamports: 6n, saleCount: 2 });
  });

  it('counts streaks over trading days, ignoring days without sales', () => {
    const at = (d: number) => Date.UTC(2026, 9, d, 12) / 1000;
    const days = dailyResults(
      [
        sale('1', at(1)),
        sale('1', at(2)),
        sale('1', at(3)),
        sale('-1', at(5)),
        sale('2', at(8)),
        sale('3', at(12)),
      ],
      'UTC',
    );
    expect(positiveStreaks(days, '2026-10-01', '2026-10-31')).toEqual({
      current: 2,
      best: 3,
    });
  });
});

describe('validatedTimelineData', () => {
  const summary = {
    observedAt: '2026-10-12T12:00:00.000Z',
    linkedSaleCount: 2,
    linkedResultLamports: '5',
    unlinkedSaleCount: 1,
  } as AccountPerformance;
  const data = {
    observedAt: summary.observedAt,
    unlinkedSaleCount: 1,
    sales: [sale('7', NOW), sale('-2', null)],
  };
  it('accepts sales that reconcile with the summary snapshot', () => {
    expect(validatedTimelineData(data, summary).sales).toHaveLength(2);
  });
  it('rejects mismatched totals, snapshots and inconsistent sale arithmetic', () => {
    expect(() =>
      validatedTimelineData(
        { ...data, sales: [data.sales[0], sale('-1', null)] },
        summary,
      ),
    ).toThrow('does not match');
    expect(() =>
      validatedTimelineData({ ...data, observedAt: 'other' }, summary),
    ).toThrow();
    expect(() =>
      validatedTimelineData(
        {
          ...data,
          sales: [
            { ...data.sales[0], netProceedsLamports: '0' },
            data.sales[1],
          ],
        },
        summary,
      ),
    ).toThrow('sale differs');
  });
});

describe('display helpers', () => {
  it('names 1D hours with their date so repeated hour labels stay distinct', () => {
    const t = buildTimeline([], '1d', 'UTC', NOW);
    const noon = t.buckets.filter((b) => b.label === '12:00');
    expect(noon.map((b) => b.title)).toEqual([
      'Oct 11, 2026, 12:00–12:59',
      'Oct 12, 2026, 12:00–12:59',
    ]);
    expect(bucketTitle('2026-10', 'month')).toBe('Oct 2026');
    expect(bucketTitle('2026-10-05', 'day')).toBe('Oct 5, 2026');
  });

  it('formats axis ticks without floating-point noise', () => {
    expect(axisSol(0.1 + 0.2)).toBe('0.3 SOL');
    expect(axisSol(-0)).toBe('0 SOL');
    expect(axisSol(-1.23456)).toBe('-1.235 SOL');
    expect(axisSol(Number.NaN)).toBe('');
  });

  it('opens the calendar on the latest month with sales, never a future one', () => {
    const today = { year: 2026, month: 10, day: 12 };
    expect(initialCalendarMonth(new Map(), today)).toEqual({
      year: 2026,
      month: 10,
    });
    const days = dailyResults(
      [
        sale('5', Date.UTC(2026, 7, 3) / 1000),
        sale('5', Date.UTC(2026, 8, 20) / 1000),
        sale('5', Date.UTC(2026, 11, 1) / 1000),
      ],
      'UTC',
    );
    expect(initialCalendarMonth(days, today)).toEqual({ year: 2026, month: 9 });
  });
});
