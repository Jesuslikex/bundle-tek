import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SupplyMovementSummary } from './supply-movement-summary';
import { supplyWallet as address } from '../test/supply-history-fixture';
import bs58 from 'bs58';
import type { SupplyMovementEvidence } from '../lib/supply-movement-evidence';
it('displays balance reconciliation without claiming complete history or P&L', () => {
  const html = renderToStaticMarkup(
    <SupplyMovementSummary
      records={[]}
      scope={{
        observationId: 'observed',
        wallet: address(1),
        mint: address(2),
        decimals: 6,
        toSlot: 200,
        previousRaw: '500',
        currentRaw: '510',
      }}
    />,
  );
  for (const text of [
    'Inspected wallet activity totals',
    'Decoded buys',
    'Decoded sells',
    'Transfers in',
    'Transfers out',
    'Unknown movements (net)',
    'Unexplained difference: +0.00001',
    'Coverage remains partial',
    'does not reconcile',
  ])
    expect(html).toContain(text);
  expect(html).not.toContain('<button');
});
it('renders a later supported classification once while retaining partial coverage', () => {
  const old: SupplyMovementEvidence = {
    observationId: 'observed',
    wallet: address(1),
    mint: address(2),
    fromSlot: 100,
    toSlot: 200,
    anchor: 201,
    requestedCursor: null,
    nextCursor: null,
    scannedSignatures: 1,
    failedSignatures: 0,
    unavailableTransactions: 0,
    completeThroughBoundary: true,
    observedAt: '2026-10-12T12:00:00.000Z',
    transactions: [
      {
        signature: bs58.encode(new Uint8Array(64).fill(1)),
        slot: 101,
        blockTime: null,
        beforeRaw: '500',
        afterRaw: '510',
        changeRaw: '10',
        decimals: 6,
        source: 'fixture.test',
      },
    ],
  };
  const updated: SupplyMovementEvidence = {
    ...old,
    observedAt: '2026-10-12T12:00:01.000Z',
    transactions: [
      {
        ...old.transactions[0],
        classification: {
          kind: 'buy',
          basis: 'protocol-route-and-transfers',
          protocol: 'Raydium CPMM',
          reason: 'Supported route evidence',
          counterpartyAccounts: [],
          quote: { mint: address(3), raw: '100', decimals: 9 },
        },
      },
    ],
  };
  const html = renderToStaticMarkup(
    <SupplyMovementSummary
      records={[updated, old]}
      scope={{
        observationId: 'observed',
        wallet: address(1),
        mint: address(2),
        decimals: 6,
        toSlot: 200,
        previousRaw: '500',
        currentRaw: '510',
      }}
    />,
  );
  expect(html).toContain('1 unique decoded transactions');
  expect(html).toMatch(/Decoded buys<\/th><td>1<\/td><td[^>]*>0.00001<\/td>/);
  expect(html).toContain('Decoded net matches');
  expect(html).toContain('Coverage remains partial');
  expect(html).not.toContain('role="alert"');
});
