import { it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountPerformanceSummary } from './account-performance';
import { summarizeAccountPerformance } from '@/lib/account-performance-server';
import {
  acquisitionFixture,
  acquisitionReceipt,
} from '../test/imported-sell-acquisition-fixture';
it('shows partial linked results with unavailable complete realized result and clear cost coverage', () => {
  const p = acquisitionFixture(2);
  const html = renderToStaticMarkup(
    <AccountPerformanceSummary
      value={summarizeAccountPerformance(
        [
          {
            id: p.projectId,
            name: 'Test token',
            archived: true,
            receipts: [
              ...p.receipts,
              acquisitionReceipt(101, 'Sell', '1', undefined, 1001),
            ],
            links: p.links,
          },
        ],
        [],
        p.observedAt,
      )}
    />,
  );
  expect(html).toContain('Unavailable');
  expect(html).toContain('1 sales have unassigned acquisition basis');
  expect(html).toContain('+0.000000016');
  expect(html).toContain('Archived');
  expect(html).toContain('Failed execution fees');
  expect(html).toContain('not total account return');
  expect(html).toContain('Export all recorded performance');
});
it('discloses bundle cost gaps and prevents a complete realized-result claim', () => {
  const p = acquisitionFixture(1);
  const value = summarizeAccountPerformance(
    [
      {
        id: p.projectId,
        name: 'Bundle',
        archived: false,
        receipts: p.receipts,
        links: p.links,
        missingBundleCostCount: 1,
      },
    ],
    [],
    p.observedAt,
  );
  const html = renderToStaticMarkup(
    <AccountPerformanceSummary value={value} />,
  );
  expect(html).toContain('Unavailable');
  expect(html).toContain('1 bundles have incomplete cost evidence');
  expect(html).toContain('Linked results include known costs only');
  expect(html).toContain('Retained bundle tips');
  expect(html).toContain('Tip transaction fees');
});
