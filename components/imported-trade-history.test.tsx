import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it, expect, vi } from 'vitest';
import {
  ImportedTradeTotals,
  ImportedTradeRecord,
} from './imported-trade-history';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { ImportedTradeReceipt } from '@/lib/imported-trade-ledger';
vi.stubGlobal('React', React);
it('renders exact settlement totals without labelling recorded cashflows as profit', () => {
  const html = renderToStaticMarkup(
    <ImportedTradeTotals
      symbol="USDC"
      decimals={6}
      summary={{
        receiptCount: 2,
        buyCount: 1,
        sellCount: 1,
        boughtRaw: '9007199254740993',
        soldRaw: '9007199254740992',
        netTokenChangeRaw: '1',
        solSpentRaw: '10000000',
        solReceivedRaw: '300000000',
        networkFeeLamports: '10000',
        nativeChangeRaw: '289980000',
        rentChangeRaw: '10000',
      }}
    />,
  );
  expect(html).toContain('9007199254.740993');
  expect(html).toContain('0.01 / 0.3');
  expect(html).toContain('0.00001');
  expect(html).toContain('before network fees and rent');
  expect(html).not.toContain('profit');
});
it('retains exact receipt evidence across archives while offering sell review only on active buys', () => {
  const receipt = {
    id: 'receipt',
    preparationId: 'preparation',
    projectRevision: 3,
    walletRevision: 2,
    createdAt: '2026-10-11T01:00:00Z',
    document: {
      side: 'Buy',
      tokenUnitsRaw: '1000',
      decimals: 6,
      wallet: 'wallet',
      slot: 42,
      nativeSettlementRaw: '-10000000',
      networkFeeLamports: '5000',
      nativeChangeRaw: '-10005000',
      rentChangeRaw: '0',
      signature: 'public-signature',
      preparationSha256: 'packet',
      observedAt: '2026-10-11T01:00:01Z',
      blockTime: null,
      source: 'provider.test',
    },
  } as ImportedTradeReceipt;
  const project = {
    archived: false,
    document: { token: { symbol: 'USDC' } },
  } as ImportedTokenProject;
  const render = (archived: boolean) =>
    renderToStaticMarkup(
      <ImportedTradeRecord
        receipt={receipt}
        project={{ ...project, archived }}
        onReviewBuy={() => {}}
      />,
    );
  expect(render(false)).toContain('Review sell of acquired tokens');
  expect(render(true)).not.toContain('Review sell of acquired tokens');
  expect(render(true)).toContain('View finalized transaction');
  expect(render(true)).toContain('Project revision 3');
  expect(render(true)).toContain('0.001 USDC');
  expect(render(true)).toContain('Block time Unavailable');
});
