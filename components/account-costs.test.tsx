import { it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountCostSummary } from './account-costs';
import { summarizeAccountCosts } from '@/lib/account-costs';
it('shows bundle tips separately and discloses missing bundle evidence', () => {
  const value = summarizeAccountCosts(
    [
      {
        category: 'Jito tips',
        signature: 'tip',
        outcome: 'success',
        feeLamports: '5',
        tipLamports: '1000',
      },
    ],
    {
      pendingCount: 0,
      missingFailureCount: 0,
      missingFinalizedCount: 0,
      missingBundleCostCount: 1,
    },
    '2026-10-11T00:00:00Z',
  );
  const html = renderToStaticMarkup(<AccountCostSummary value={value} />);
  expect(html).toContain('Jito tips');
  expect(html).toContain('Retained bundle tips');
  expect(html).toContain('separate from network fees and counted once');
  expect(html).toContain('Bundles with incomplete cost evidence: 1');
  expect(html).toContain('Fee coverage is incomplete');
});
it('shows missing proof coverage and exact failure fees without implying account return', () => {
  const html = renderToStaticMarkup(
    <AccountCostSummary
      value={summarizeAccountCosts(
        [
          {
            category: 'Withdrawals',
            signature: 'one',
            outcome: 'failed',
            feeLamports: '1',
          },
        ],
        { pendingCount: 2, missingFailureCount: 1, missingFinalizedCount: 1 },
        '2026-10-11T00:00:00Z',
      )}
    />,
  );
  expect(html).toContain('0.000000001');
  expect(html).toContain('Fee coverage is incomplete');
  expect(html).toContain('not total account return');
  expect(html).toContain(
    'Failed transactions without captured fee evidence: 1',
  );
});
