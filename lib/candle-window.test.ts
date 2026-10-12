import { expect, it } from 'vitest';
import {
  candleWindow,
  candleContainingTime,
  focusCandleWindow,
  dragCandleWindow,
  moveCandleWindow,
  nearestCandle,
  zoomCandleWindow,
} from './candle-window';
const rows = Array.from({ length: 120 }, (_, n) => ({
  time: n * 3600,
  open: 1,
  high: 2,
  low: 0.5,
  close: 1.5,
  volume: n,
}));
it('locates observation ends inside recorded intervals, never across gaps', () => {
  expect(candleContainingTime(rows, 3601, 3600)?.time).toBe(3600);
  expect(candleContainingTime(rows, 3600, 3600)?.time).toBe(3600);
  expect(candleContainingTime([rows[0], rows[3]], 3600, 3600)).toBeUndefined();
  expect(candleContainingTime(rows, -1, 3600)).toBeUndefined();
  expect(candleContainingTime(rows, 120 * 3600, 3600)).toBeUndefined();
  expect(candleContainingTime([], 0, 3600)).toBeUndefined();
  expect(candleContainingTime(rows, NaN, 3600)).toBeUndefined();
  expect(candleContainingTime(rows, 0, 0)).toBeUndefined();
});
it('focuses an actual candle and clamps the visible history at both ends', () => {
  expect(
    candleWindow(rows, 24, focusCandleWindow(rows, 24, 60 * 3600)).rows.some(
      (c) => c.time === 60 * 3600,
    ),
  ).toBe(true);
  expect(focusCandleWindow(rows, 24, 0)).toBe(23 * 3600);
  expect(focusCandleWindow(rows, 24, 119 * 3600)).toBe(null);
  expect(() => focusCandleWindow(rows, 24, 1)).toThrow();
});
it('zooms around an inspected candle while retaining its relative position', () => {
  const end = zoomCandleWindow(rows, 100, null, 24, 70 * 3600);
  const view = candleWindow(rows, 24, end);
  expect(view.rows).toHaveLength(24);
  expect(view.rows.some((c) => c.time === 70 * 3600)).toBe(true);
  const before = (70 - 20) / 99;
  const after = (70 - view.start) / 23;
  expect(Math.abs(before - after)).toBeLessThan(1 / 23);
  expect(zoomCandleWindow(rows, 100, null, 24, 119 * 3600)).toBe(null);
  expect(zoomCandleWindow(rows, 24, 23 * 3600, 100, 0)).toBe(99 * 3600);
  expect(zoomCandleWindow(rows, 24, 70 * 3600, 500, 60 * 3600)).toBe(null);
});
it('uses observed candles for zoom anchors across gaps and rejects invalid terms', () => {
  const gapped = rows.filter((c) => c.time !== 70 * 3600);
  const end = zoomCandleWindow(gapped, 100, null, 24, 70 * 3600);
  expect(
    candleWindow(gapped, 24, end).rows.some((c) => c.time === 69 * 3600),
  ).toBe(true);
  expect(
    candleWindow(gapped, 24, end).rows.some((c) => c.time === 70 * 3600),
  ).toBe(false);
  expect(zoomCandleWindow([], 24, null, 12, 0)).toBe(null);
  expect(() => zoomCandleWindow(rows, 24, null, 0, 0)).toThrow();
  expect(() => zoomCandleWindow(rows, 24, null, 501, 0)).toThrow();
  expect(() => zoomCandleWindow(rows, 24, null, 12, NaN)).toThrow();
});
it('drags from a fixed history anchor, with edge clamps and screen-width scaling', () => {
  expect(dragCandleWindow(rows, 24, null, 100, 230)).toBe(109 * 3600);
  expect(dragCandleWindow(rows, 24, null, 200, 460)).toBe(109 * 3600);
  expect(dragCandleWindow(rows, 24, 109 * 3600, -100, 230)).toBe(null);
  expect(dragCandleWindow(rows, 24, null, 10000, 230)).toBe(23 * 3600);
  expect(dragCandleWindow(rows, 24, null, -10000, 230)).toBe(null);
  expect(dragCandleWindow(rows, 500, null, 200, 230)).toBe(null);
  expect(dragCandleWindow([], 24, null, 10, 230)).toBe(null);
  for (const [delta, width] of [
    [NaN, 10],
    [10, 0],
    [10, Infinity],
  ])
    expect(() => dragCandleWindow(rows, 24, null, delta, width)).toThrow();
});
it('inspects the nearest actual candle without inventing values in gaps', () => {
  const gapped = [rows[0], rows[4]];
  expect(nearestCandle(gapped, 2 * 3600)?.time).toBe(0);
  expect(nearestCandle(gapped, 3 * 3600)?.time).toBe(4 * 3600);
  expect(nearestCandle(gapped, -100)?.time).toBe(0);
  expect(nearestCandle(gapped, 99999)?.time).toBe(4 * 3600);
  expect(nearestCandle([], 1)).toBeUndefined();
  expect(nearestCandle(gapped, NaN)).toBeUndefined();
});
it('zooms latest history and preserves actual time gaps', () => {
  const gapped = rows.filter((r) => r.time !== 100 * 3600);
  const view = candleWindow(gapped, 24);
  expect(view.rows).toHaveLength(24);
  expect(view.rows.at(-1)?.time).toBe(119 * 3600);
  expect(view.rows.some((r) => r.time === 100 * 3600)).toBe(false);
  expect(view.earlier).toBe(true);
  expect(view.later).toBe(false);
});
it('pans by half a window, clamps both edges and returns to latest', () => {
  const earlier = moveCandleWindow(rows, 24, null, -1);
  expect(earlier).toBe(107 * 3600);
  expect(candleWindow(rows, 24, earlier).rows[0].time).toBe(84 * 3600);
  expect(moveCandleWindow(rows, 24, earlier, 1)).toBe(null);
  expect(moveCandleWindow(rows, 24, 23 * 3600, -1)).toBe(23 * 3600);
  expect(candleWindow(rows, 500).rows).toHaveLength(120);
});
it('anchors historical windows when new candles arrive and handles empty data', () => {
  expect(candleWindow(rows, 24, 60 * 3600).rows.at(-1)?.time).toBe(60 * 3600);
  expect(candleWindow([], 24).rows).toEqual([]);
  expect(candleWindow(rows.slice(80), 24, 60 * 3600).rows).toHaveLength(24);
  expect(moveCandleWindow([], 24, null, -1)).toBe(null);
  expect(() => candleWindow(rows, 0)).toThrow();
});
