import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { TransactionBalanceDetails } from './tracked-transaction-panel';
import type { TrackedTransaction } from '@/lib/tracked-wallet-transaction';
vi.stubGlobal('React', React);
const transaction: TrackedTransaction = {
  address: 'wallet',
  network: 'mainnet',
  signature: 'signature',
  slot: 20,
  blockTime: null,
  failed: false,
  feeRaw: '5000',
  feePayer: 'different-payer',
  walletSigner: false,
  nativeChangeRaw: '-1',
  tokensComplete: true,
  tokenChanges: [
    {
      mint: 'mint',
      program: 'program',
      decimals: 9,
      beforeRaw: '9007199254740993',
      afterRaw: '9007199254740992',
      changeRaw: '-1',
      accounts: ['token-account'],
    },
  ],
  programs: ['program'],
  innerInstructionsAvailable: true,
  observedAt: '2026-10-10T15:00:00.000Z',
  source: 'example.test',
  commitment: 'confirmed',
};
it('renders subunit changes exactly and identifies the fee payer separately from the wallet', () => {
  const html = renderToStaticMarkup(
    <TransactionBalanceDetails transaction={transaction} />,
  );
  expect(html).toContain('-0.000000001 SOL');
  expect(html).toContain('9007199.254740993');
  expect(html).toContain('9007199.254740992');
  expect(html).toContain('different-payer');
  expect(html).toContain('0.000005');
  expect(html).toContain('not a finalized receipt');
});
it('shows failed status and unavailable token/inner metadata explicitly', () => {
  const html = renderToStaticMarkup(
    <TransactionBalanceDetails
      transaction={{
        ...transaction,
        failed: true,
        tokensComplete: false,
        tokenChanges: [],
        innerInstructionsAvailable: false,
      }}
    />,
  );
  expect(html).toContain('Failed transaction');
  expect(html).toContain('Token changes are unavailable');
  expect(html).toContain('Only top-level programs');
  expect(html).not.toContain('No token accounts attributed');
});
