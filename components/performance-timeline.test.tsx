import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { PerformanceTimeline } from './performance-timeline';
import type { RealizedSale } from '@/lib/performance-timeline';
vi.stubGlobal('React', React);

const NOW = Date.UTC(2026, 9, 12, 12) / 1000;
const sale = (
  saleId: string,
  resultLamports: string,
  blockTime: number | null,
): RealizedSale => ({
  kind: 'Warmup',
  scopeId: '00000000-0000-4000-8000-000000000001',
  scopeName: 'Recorded warmup',
  saleId,
  signature: '5'.repeat(87),
  wallet: 'Wallet1111111111111111111111111111111111111',
  slot: 1,
  blockTime,
  costLamports: '1000000000',
  netProceedsLamports: (1_000_000_000n + BigInt(resultLamports)).toString(),
  resultLamports,
});

it('renders exact window totals, win rate, calendar and coverage disclosures', () => {
  const html = renderToStaticMarkup(
    <PerformanceTimeline
      nowSeconds={NOW}
      data={{
        observedAt: new Date(NOW * 1000).toISOString(),
        unlinkedSaleCount: 2,
        sales: [
          sale('a', '1500000001', NOW - 3600),
          sale('b', '-500000000', NOW - 7200),
          sale('c', '42', null),
        ],
      }}
    />,
  );
  expect(html).toContain('+1.000000001 SOL');
  expect(html).toContain('Win rate');
  expect(html).toContain('50%');
  expect(html).toContain('Results calendar');
  expect(html).toContain('October 2026');
  expect(html).toContain('1 sale without a reported block time is excluded');
  expect(html).toContain('2 sales without linked buys are excluded');
  expect(html).toContain('aria-pressed="true"');
});

it('shows an explicit empty state instead of a zero-filled chart', () => {
  const html = renderToStaticMarkup(
    <PerformanceTimeline
      nowSeconds={NOW}
      data={{
        observedAt: new Date(NOW * 1000).toISOString(),
        unlinkedSaleCount: 0,
        sales: [],
      }}
    />,
  );
  expect(html).toContain('No linked sales in this period.');
  expect(html).toContain('No sales this month');
});
