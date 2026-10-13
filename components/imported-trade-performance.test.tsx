import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it, expect, vi } from 'vitest';
import { importedTradePerformance } from '@/lib/imported-trade-performance';
import {
  ImportedTradePerformance,
  ImportedPerformanceResults,
} from './imported-trade-performance';
import {
  validatedImportedPerformance,
  type ImportedPerformance,
} from '@/lib/imported-performance-format';
import bs58 from 'bs58';
import { acquisitionFixture } from '../test/imported-sell-acquisition-fixture';
vi.stubGlobal('React', React);
it('discloses incomplete bundle expense evidence in FIFO accounting', () => {
  const page = acquisitionFixture(1);
  const performance = importedTradePerformance(page.receipts, {
    executionCosts: {},
    bundleTipLamports: '0',
    bundleFeeLamports: '0',
    missingBundleCostCount: 1,
  });
  const html = renderToStaticMarkup(
    <ImportedPerformanceResults
      performance={performance}
      decimals={page.decimals}
    />,
  );
  expect(html).toContain('1 bundles have incomplete cost evidence');
  expect(html).toContain('complete realized estimates are unavailable');
  expect(html).toContain('Unavailable');
  expect(html).toContain('Tip transaction fees');
});
it('requires explicit selection before showing an accounting estimate', () => {
  const html = renderToStaticMarkup(
    <ImportedTradePerformance
      decimals={6}
      performance={importedTradePerformance([])}
    />,
  );
  expect(html).toContain('Show recorded FIFO accounting estimate');
  expect(html).not.toContain('checked=""');
  expect(html).not.toContain('Recorded realized estimate');
});

it('renders losses and missing order without inventing aggregate gains', () => {
  const amounts = {
    matchedSoldRaw: '3',
    unknownBasisSoldRaw: '0',
    unresolvedSoldRaw: '0',
    realizedCostLamports: '101',
    attributedNetProceedsLamports: '49',
    attributedResultLamports: '-52',
    realizedResultLamports: '-52',
    openCostLamports: '0',
    recordedOpenRaw: '0',
  };
  const p: ImportedPerformance = {
    method: 'recorded-fifo',
    receiptCount: 2,
    buyCount: 1,
    sellCount: 1,
    ...amounts,
    wallets: [
      {
        wallet: bs58.encode(new Uint8Array(32).fill(3)),
        receiptCount: 2,
        buyCount: 1,
        sellCount: 1,
        ordering: 'by-finalized-slot',
        ...amounts,
      },
    ],
  };
  validatedImportedPerformance(p, 2, '3', '3');
  const html = renderToStaticMarkup(
    <ImportedPerformanceResults decimals={6} performance={p} />,
  );
  expect(html).toContain('-0.000000052 SOL');
  expect(html).toContain('accounting assumption');
  expect(html).toContain('failed transaction fees');
  const unresolved = {
    ...amounts,
    matchedSoldRaw: '0',
    unresolvedSoldRaw: '3',
    realizedCostLamports: '0',
    attributedNetProceedsLamports: '0',
    attributedResultLamports: '0',
    realizedResultLamports: null,
    openCostLamports: null,
    recordedOpenRaw: null,
  };
  const missing: ImportedPerformance = {
    ...p,
    ...unresolved,
    wallets: [{ ...p.wallets[0], ...unresolved, ordering: 'unavailable' }],
  };
  validatedImportedPerformance(missing, 2, '3', '3');
  const absent = renderToStaticMarkup(
    <ImportedPerformanceResults decimals={6} performance={missing} />,
  );
  expect(absent).toContain('Unavailable');
  expect(absent).toContain('share a finalized slot');
  expect(absent).not.toContain('+0.000');
});
