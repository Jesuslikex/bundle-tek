import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { PnlCardPanel } from './pnl-card-panel';
import type { ImportedPerformance } from '@/lib/imported-performance-format';
vi.stubGlobal('React', React);

const performance: ImportedPerformance = {
  method: 'recorded-fifo',
  receiptCount: 2,
  buyCount: 1,
  sellCount: 1,
  wallets: [],
  matchedSoldRaw: '1',
  unknownBasisSoldRaw: '0',
  unresolvedSoldRaw: '0',
  realizedCostLamports: '1000000000',
  attributedNetProceedsLamports: '1500000000',
  attributedResultLamports: '500000000',
  realizedResultLamports: '500000000',
  openCostLamports: '0',
  recordedOpenRaw: '0',
};

it('renders a card with return and realized SOL', () => {
  const html = renderToStaticMarkup(
    <PnlCardPanel performance={performance} symbol="BNDL" />,
  );
  expect(html).toContain('+50.00%');
  expect(html).toContain('$BNDL');
  expect(html).toContain('Download card');
});

it('renders nothing when the estimate is incomplete', () => {
  expect(
    renderToStaticMarkup(
      <PnlCardPanel
        performance={{ ...performance, realizedResultLamports: null }}
        symbol="BNDL"
      />,
    ),
  ).toBe('');
});
