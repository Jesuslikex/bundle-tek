import { expect, it } from 'vitest';
import { chartTradeMarkers } from './chart-trade-markers';
import type { PoolCandles } from './pool-candles';
import { supplyScope, supplyProject } from '../test/supply-history-fixture';
import { chartTradeFixture } from '../test/chart-trade-fixture';
const start = 1791716400;
const snapshot: PoolCandles = {
  chain: 'Solana',
  address: supplyScope.mint,
  pool: supplyScope.mint,
  interval: '1h',
  source: 'api.geckoterminal.com',
  observedAt: '2026-10-11T12:01:00Z',
  executionAllowed: false,
  candles: [0, 2].map((n) => ({
    time: start + n * 3600,
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 10,
  })),
};
it('groups verified buys/sells in actual candle windows and deduplicates signatures', () => {
  const rows = [
    chartTradeFixture(),
    chartTradeFixture('Buy', 2),
    chartTradeFixture('Sell', 3),
    chartTradeFixture(),
  ];
  const result = chartTradeMarkers(snapshot, rows, supplyProject, 6);
  expect(result.groups.map((g) => [g.side, g.receipts.length])).toEqual([
    ['Buy', 2],
    ['Sell', 1],
  ]);
  expect(result.matched).toHaveLength(3);
});
it('does not fabricate positions for null block times or candle gaps', () => {
  const result = chartTradeMarkers(
    snapshot,
    [
      chartTradeFixture('Buy', 1, null),
      chartTradeFixture('Buy', 2, start + 3600),
      chartTradeFixture('Buy', 3, start + 3 * 3600),
    ],
    supplyProject,
    6,
  );
  expect(result.groups).toEqual([]);
  expect(result.missingTime).toBe(1);
  expect(result.outsideCandles).toBe(2);
});
it('maps the next candle boundary exactly and rejects unverified or foreign receipts', () => {
  expect(
    chartTradeMarkers(
      snapshot,
      [chartTradeFixture('Buy', 1, start + 2 * 3600)],
      supplyProject,
      6,
    ).groups[0].time,
  ).toBe(start + 2 * 3600);
  const r = chartTradeFixture();
  r.document.commitment = 'confirmed';
  expect(() => chartTradeMarkers(snapshot, [r], supplyProject, 6)).toThrow();
  expect(() =>
    chartTradeMarkers(snapshot, [chartTradeFixture()], 'foreign', 6),
  ).toThrow();
});
