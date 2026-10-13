import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { HolderIndexResults } from './holder-index-panel';
import {
  appendHolderIndexPage,
  type HolderIndexPage,
} from '@/lib/holder-index';
import { supplyWallet } from '../test/supply-history-fixture';
vi.stubGlobal('React', React);
const page: HolderIndexPage = {
  mint: supplyWallet(9),
  page: 1,
  decimals: 6,
  totalSupplyRaw: '1000000',
  source: 'index.test',
  indexedSlot: 190,
  supplySlot: 200,
  observedAt: '2026-10-12T03:00:00Z',
  accounts: [
    {
      address: supplyWallet(1),
      owner: supplyWallet(2),
      raw: '200000',
      frozen: false,
    },
  ],
};
it('distinguishes partial rankings from provider exhaustion without claiming an atomic or global snapshot', () => {
  const scan = appendHolderIndexPage(null, page, page.mint, 6);
  const partial = renderToStaticMarkup(<HolderIndexResults scan={scan} />);
  expect(partial).toContain('Partial enumeration');
  expect(partial).toContain('20.0000%');
  expect(partial).toContain('not an atomic on-chain snapshot');
  expect(partial).toContain('pool and team');
  const exhausted = appendHolderIndexPage(
    scan,
    { ...page, page: 2, accounts: [] },
    page.mint,
    6,
  );
  const final = renderToStaticMarkup(<HolderIndexResults scan={exhausted} />);
  expect(final).toContain('Provider enumeration exhausted');
  expect(final).toContain('not proof of globally complete');
  expect(final).toContain('Remainder outside those balances: 0.8 tokens');
});
it('separates mint and account fees from holder rankings and discloses confidential coverage', () => {
  const feePage: HolderIndexPage = {
    ...page,
    enumeration: 'program-accounts-v2',
    requestedCursor: null,
    nextCursor: null,
    tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    mintObservation: {
      slot: 201,
      withheldRaw: '500000',
      extensions: ['transferFeeConfig', 'confidentialTransferMint'],
    },
    accounts: page.accounts.map((account) => ({
      ...account,
      withheldRaw: '300000',
      extensions: [
        'transferFeeAmount',
        'confidentialTransferAccount',
        'unparseableExtension',
      ],
    })),
  };
  const scan = appendHolderIndexPage(null, feePage, page.mint, 6);
  const html = renderToStaticMarkup(<HolderIndexResults scan={scan} />);
  expect(html).toContain('20.0000%');
  expect(html).toContain('0.3 tokens in 1 accounts');
  expect(html).toContain('Observed mint-harvested fees: 0.5 tokens');
  expect(html).toContain('Unexplained remainder after observed fees: 0 tokens');
  expect(html).toContain(
    'Encrypted balances and encrypted fees are not measured',
  );
  expect(html).toContain('does not establish complete hidden-balance coverage');
  expect(html).toContain('Some account extensions could not be parsed');
});
