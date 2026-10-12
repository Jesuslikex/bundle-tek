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
  expect(final).toContain('Unreconciled remainder: 0.8 tokens');
});
