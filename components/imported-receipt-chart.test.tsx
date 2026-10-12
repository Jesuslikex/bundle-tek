import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ImportedReceiptChart } from './imported-receipt-chart';
import bs58 from 'bs58';
import type { ImportedSwapReceipt } from '@/lib/imported-approval-history';
import { supplyWallet } from '../test/supply-history-fixture';
vi.stubGlobal('React', React);
it('offers an internal project chart handoff only for a verified finalized receipt', () => {
  const receipt = {
    id: 'r',
    projectId: 'p',
    projectRevision: 1,
    document: {
      mint: supplyWallet(9),
      wallet: supplyWallet(1),
      network: 'mainnet',
      commitment: 'finalized',
      signatureVerified: true,
      signature: bs58.encode(new Uint8Array(64).fill(1)),
      side: 'Buy',
      tokenUnitsRaw: '1',
    },
  } as ImportedSwapReceipt;
  const html = renderToStaticMarkup(<ImportedReceiptChart receipt={receipt} />);
  expect(html).toContain('href="#imported-chart-p"');
  expect(html).toContain('Open chart, supply and wallet alerts');
  expect(
    renderToStaticMarkup(
      <ImportedReceiptChart
        receipt={{
          ...receipt,
          document: { ...receipt.document, commitment: 'confirmed' },
        }}
      />,
    ),
  ).toBe('');
});
