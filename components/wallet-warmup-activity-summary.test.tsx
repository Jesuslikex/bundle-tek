import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { WalletWarmupActivitySummary } from './wallet-warmup-activity-summary';
vi.stubGlobal('React', React);
it('renders exact volume, receipt counts and recovery separately from completion without execution controls', () => {
  const html = renderToStaticMarkup(
    <WalletWarmupActivitySummary
      rows={[
        {
          wallet: 'synthetic-wallet',
          completedCycles: 1,
          totalCycles: 3,
          buyTransactions: 2,
          sellTransactions: 3,
          transactionCount: 5,
          buyVolumeLamports: '9007199254740993',
          sellVolumeLamports: '100',
          volumeLamports: '9007199254741093',
          recoveryCount: 1,
          state: 'Recovery required',
        },
      ]}
    />,
  );
  expect(html).toContain('9007199.254741093 SOL');
  expect(html).toContain('2 buys, 3 sells');
  expect(html).toContain('value="1" max="3"');
  expect(html).toContain('Recovery required');
  expect(html).toContain('not profit or a current wallet balance');
  expect(html).not.toContain('<button');
  expect(html).not.toContain('Recorded loops complete');
});
