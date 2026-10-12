import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it, expect, vi } from 'vitest';
import { WarmupPerformance } from './warmup-performance';
vi.stubGlobal('React', React);
const empty = {
  lotCount: 0,
  soldLotCount: 0,
  openLotCount: 0,
  realizedCostLamports: '0',
  openCostLamports: '0',
  netSellProceedsLamports: '0',
  realizedResultLamports: '0',
  networkFeeLamports: '0',
  rentChangeLamports: '0',
  lots: [],
};
it('renders no evidence separately from losses and discloses accounting scope', () => {
  const blank = renderToStaticMarkup(<WarmupPerformance performance={empty} />);
  expect(blank).toContain('No realized result is available');
  const html = renderToStaticMarkup(
    <WarmupPerformance
      performance={{
        ...empty,
        lotCount: 1,
        soldLotCount: 1,
        realizedResultLamports: '-9007199254740993',
        openCostLamports: '68',
      }}
    />,
  );
  expect(html).toContain('-9007199.254740993 SOL');
  expect(html).toContain('0.000000068 SOL');
  expect(html).toContain('failed transaction fees');
  expect(html).toContain('not a market valuation');
  expect(blank).not.toContain('<button');
});
