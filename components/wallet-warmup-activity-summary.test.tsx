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
          completedCycles: 0,
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
  expect(html).not.toContain('<progress');
  expect(html).toContain('Loop count withheld');
  expect(html).toContain('Awaiting recovery');
  expect(html).toContain('These may belong to another plan');
  expect(html).toContain('Recovery required');
  expect(html).toContain('not profit or a current wallet balance');
  expect(html).not.toContain('<button');
  expect(html).not.toContain('Recorded loops complete');
});
it('shows explicit historical and archived scope without claiming an active session', () => {
  const html = renderToStaticMarkup(
    <WalletWarmupActivitySummary
      rows={[]}
      revision={3}
      includeEarlier
      archived
    />,
  );
  expect(html).toContain('No wallets in this recorded view');
  expect(html).toContain('Archived plan');
  expect(html).toContain('Saved revision 3.');
  expect(html).toContain('Earlier matching revisions included.');
  expect(html).toContain('not a running session');
  expect(html).not.toContain('All recorded loops complete');
});
it('renders a compact complete receipt table with exact aggregate totals', () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({
    wallet: `synthetic-wallet-${i}`,
    completedCycles: 11,
    totalCycles: 11,
    buyTransactions: 11,
    sellTransactions: 11,
    transactionCount: 22,
    buyVolumeLamports: '1000000',
    sellVolumeLamports: '1000000',
    volumeLamports: '2000000',
    recoveryCount: 0,
    state: 'Recorded loops complete',
  }));
  const html = renderToStaticMarkup(
    <WalletWarmupActivitySummary rows={rows} revision={4} includeEarlier />,
  );
  expect(html).toContain('All recorded loops complete');
  expect(html).toContain('154');
  expect(html).toContain('0.014 SOL');
  expect(html).toContain('Saved revision 4.');
  expect(html).toContain('Earlier matching revisions included.');
  expect(html).toContain('scope="col"');
  expect(html).toContain('scope="row"');
  expect(html).toContain('value="77" max="77"');
  expect(html).not.toContain('Session completed successfully');
});
it('withholds malformed totals rather than showing a partial or fabricated result', () => {
  const html = renderToStaticMarkup(
    <WalletWarmupActivitySummary
      rows={[{ wallet: 'private-wallet', volumeLamports: 'broken' }] as never}
    />,
  );
  expect(html).toContain('role="alert"');
  expect(html).not.toContain('private-wallet');
  expect(html).not.toContain('broken');
  expect(html).not.toContain('<table');
});
