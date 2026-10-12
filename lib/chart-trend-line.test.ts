import { expect, it } from 'vitest';
import { visibleTrendLine } from './chart-trend-line';
const line = { first: { time: 0, price: 1 }, second: { time: 100, price: 3 } };
it('retains the anchored prices and times inside a full window', () => {
  expect(
    visibleTrendLine(line, { start: 0, end: 100, low: 1, high: 3 }),
  ).toEqual(line);
});
it('interpolates across a zoomed window when both anchors are offscreen', () => {
  expect(
    visibleTrendLine(line, { start: 25, end: 75, low: 1, high: 3 }),
  ).toEqual({
    first: { time: 25, price: 1.5 },
    second: { time: 75, price: 2.5 },
  });
});
it('clips at price boundaries without moving retained anchors', () => {
  expect(
    visibleTrendLine(line, { start: 0, end: 100, low: 1.5, high: 2.5 }),
  ).toEqual({
    first: { time: 25, price: 1.5 },
    second: { time: 75, price: 2.5 },
  });
  expect(line.first).toEqual({ time: 0, price: 1 });
});
it('handles reversed and horizontal drawings', () => {
  expect(
    visibleTrendLine(
      { first: line.second, second: line.first },
      { start: 25, end: 75, low: 1, high: 3 },
    )?.first,
  ).toEqual({ time: 75, price: 2.5 });
  expect(
    visibleTrendLine(
      { first: { time: 0, price: 2 }, second: { time: 100, price: 2 } },
      { start: 25, end: 75, low: 1, high: 3 },
    )?.second,
  ).toEqual({ time: 75, price: 2 });
});
it('hides lines outside the time or price window', () => {
  expect(
    visibleTrendLine(line, { start: 101, end: 200, low: 1, high: 3 }),
  ).toBeNull();
  expect(
    visibleTrendLine(line, { start: 0, end: 100, low: 4, high: 5 }),
  ).toBeNull();
});
it('rejects invalid and same-candle anchors', () => {
  expect(
    visibleTrendLine(
      { first: line.first, second: line.first },
      { start: 0, end: 100, low: 1, high: 3 },
    ),
  ).toBeNull();
  expect(
    visibleTrendLine(line, { start: NaN, end: 100, low: 1, high: 3 }),
  ).toBeNull();
});
