import { it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImportedLinkedResults } from './imported-lot-links';
import { importedLotPage } from '@/lib/imported-lot-links';
import { acquisitionFixture } from '../test/imported-sell-acquisition-fixture';
it('distinguishes empty linked accounting from zero realized gains', () => {
  const page = importedLotPage(
    {
      projectId: 'project',
      mint: 'mint',
      decimals: 6,
      revision: 0,
      receipts: [],
      links: [],
      receiptDocumentHashes: {},
      observedAt: '2026-10-11T00:00:00Z',
    },
    'project',
    'mint',
    6,
  );
  const html = renderToStaticMarkup(<ImportedLinkedResults page={page} />);
  expect(html).toContain('No finalized sales recorded');
  expect(html).toContain('No linked sales');
  expect(html).toContain('total account return');
  expect(html).toContain('failed transaction');
});
it('shows missing bundle costs instead of a complete linked result', () => {
  const base = acquisitionFixture(1);
  const page = importedLotPage(
    {
      ...base,
      expenses: {
        executionCosts: {},
        bundleTipLamports: '0',
        bundleFeeLamports: '0',
        missingBundleCostCount: 1,
      },
    },
    base.projectId,
    base.mint,
    base.decimals,
  );
  const html = renderToStaticMarkup(<ImportedLinkedResults page={page} />);
  expect(html).toContain('Unavailable until bundle cost evidence is complete');
  expect(html).toContain('Linked results include known costs only');
  expect(html).toContain('Retained bundle tips');
});
