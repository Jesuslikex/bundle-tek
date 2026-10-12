import { expect, it } from 'vitest';
import {
  chartDrawingStorageKey,
  parseChartDrawingDocument,
} from './chart-drawing-document';
const context = 'project:Solana:mint:pool:5m';
const document = {
  format: 'bundle-chart-drawings-v1',
  context,
  savedAt: '2026-10-12T00:00:00.000Z',
  guides: [0.12],
  trends: [
    { first: { time: 100, price: 0.11 }, second: { time: 200, price: 0.13 } },
  ],
};
it('round trips exact prices and anchors, excluding untrusted extra fields', () => {
  expect(
    parseChartDrawingDocument(
      JSON.stringify({ ...document, extra: 'untrusted' }),
      context,
    ),
  ).toEqual(document);
});
it('rejects cross-project, mint, pool and interval documents', () => {
  for (const other of [
    'other:Solana:mint:pool:5m',
    'project:Solana:other:pool:5m',
    'project:Solana:mint:other:5m',
    'project:Solana:mint:pool:1h',
  ]) {
    expect(() =>
      parseChartDrawingDocument(JSON.stringify(document), other),
    ).toThrow();
    expect(chartDrawingStorageKey(other)).not.toEqual(
      chartDrawingStorageKey(context),
    );
  }
});
it('rejects oversized, malformed and unsupported documents', () => {
  for (const text of [
    'x'.repeat(8193),
    '{',
    'null',
    '[]',
    JSON.stringify({ ...document, format: 'v2' }),
    JSON.stringify({ ...document, savedAt: 'invalid' }),
  ]) {
    expect(() => parseChartDrawingDocument(text, context)).toThrow();
  }
});
it('rejects duplicate, nonpositive, nonnumeric and excessive guides', () => {
  for (const guides of [
    [0],
    [-1],
    ['0.12'],
    [null],
    [0.12, 0.12],
    Array(9).fill(1),
  ]) {
    expect(() =>
      parseChartDrawingDocument(
        JSON.stringify({ ...document, guides }),
        context,
      ),
    ).toThrow();
  }
});
it('rejects invalid anchors, same-candle and excessive trend lines', () => {
  for (const trends of [
    Array(9).fill(document.trends[0]),
    [{ first: { time: 1.5, price: 1 }, second: { time: 2, price: 2 } }],
    [{ first: { time: 1, price: 1 }, second: { time: 1, price: 2 } }],
    [{ first: null, second: {} }],
  ]) {
    expect(() =>
      parseChartDrawingDocument(
        JSON.stringify({ ...document, trends }),
        context,
      ),
    ).toThrow();
  }
});
