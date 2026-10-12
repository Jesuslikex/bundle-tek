import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ImportedTradeWallets } from './imported-trade-wallets';
import type { WorkspaceWallet, WalletFolder } from '@/lib/wallet-workspace';
import type { WalletBalance } from '@/lib/wallet-balance-format';
const wallet: WorkspaceWallet = {
  chain: 'Solana',
  address: 'public-wallet-a',
  folderId: 'one',
  folderIds: ['one', 'two'],
  label: 'Reserve',
  role: 'Recipient',
  archived: false,
  revision: 1,
  updatedAt: '2026-10-11T00:00:00Z',
};
const folders: WalletFolder[] = [
  {
    id: 'one',
    name: 'Trading',
    chain: 'Solana',
    archived: false,
    revision: 1,
    updatedAt: wallet.updatedAt,
  },
  {
    id: 'two',
    name: 'Archived secret folder',
    chain: 'Solana',
    archived: true,
    revision: 1,
    updatedAt: wallet.updatedAt,
  },
];
const balance: WalletBalance = {
  chain: 'Solana',
  address: wallet.address,
  raw: '18446744073709551615',
  amount: '18446744073.709551615',
  currency: 'SOL',
  decimals: 9,
  blockNumber: 1,
  blockHash: null,
  observedAt: wallet.updatedAt,
  snapshotId: 'public',
  source: 'fixture.test',
  commitment: 'finalized',
};
function render(
  wallets: WorkspaceWallet[],
  balances: WalletBalance[],
  locked = false,
) {
  return renderToStaticMarkup(
    <ImportedTradeWallets
      wallets={wallets}
      folders={folders}
      balances={balances}
      selected={wallet.address}
      locked={locked}
      onReview={() => {
        throw new Error('Render cannot initiate review');
      }}
    />,
  );
}
it('bounds visible wallet rows while retaining the complete matching count', () => {
  const wallets = Array.from({ length: 26 }, (_, i) => ({
    ...wallet,
    address: `public-wallet-${i}`,
    label: `Wallet ${i}`,
  }));
  const html = render(wallets, []);
  expect(html).toContain('26 matching active Solana wallets');
  expect(html).toContain('Page 1 of 2');
  expect(html).toContain('Review buy with public-wallet-24');
  expect(html).not.toContain('Review buy with public-wallet-25');
  expect(html).toContain('Next wallets');
});
it('shows exact saved native evidence and restricts the roster to active Solana wallets and active folders', () => {
  const html = render(
    [
      wallet,
      { ...wallet, address: 'hidden-archive', archived: true },
      { ...wallet, chain: 'Base', address: 'hidden-evm' },
    ],
    [balance],
  );
  expect(html).toContain('18446744073.709551615 SOL');
  expect(html).toContain('Trading');
  expect(html).not.toContain('Archived secret folder');
  expect(html).not.toContain('hidden-archive');
  expect(html).not.toContain('hidden-evm');
  expect(html).toContain('Selected for review');
  expect(html).toContain('Saved SOL observations may be old');
});
it('withholds inconsistent, ambiguous or wrong-network saved balances and disables row actions during locks', () => {
  for (const balances of [
    [{ ...balance, amount: '100' }],
    [balance, balance],
    [{ ...balance, raw: '18446744073709551616' }],
    [{ ...balance, chain: 'Base' as const }],
    [{ ...balance, observedAt: 'invalid' }],
  ]) {
    const html = render([wallet], balances, true);
    expect(html).toContain('No valid saved observation');
    expect(html).not.toContain('18446744073.709551615 SOL');
    expect(html.match(/\sdisabled=""/g)).toHaveLength(2);
  }
});
