import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { SimulatedSwapTokenBalances } from './simulated-swap-token-balances';
import type { ImportedSwapSimulation } from '@/lib/imported-swap-simulation';
vi.stubGlobal('React', React);
const simulation: ImportedSwapSimulation = {
  settlementEvidence: null,
  accountBindings: {
    slot: null,
    status: 'Unavailable',
    accounts: [],
    limitations: 'Test fixture',
  },
  routeAssessment: {
    status: 'Unavailable',
    checks: {},
    decoded: null,
    issues: [],
    source: 'Test fixture',
    instructionsVerified: false,
    executionAllowed: false,
    limitations: 'Test fixture',
  },
  instructionReview: {
    instructionsVerified: false,
    executionAllowed: false,
    unresolvedAccountCount: 0,
    unrecognizedInstructionCount: 0,
    authorityActionCount: 0,
    instructions: [],
    limitations: 'Test fixture',
  },
  lookupObservation: null,
  executionAllowed: false,
  instructionsVerified: false,
  sha256: 'fingerprint',
  wallet: 'wallet',
  succeeded: true,
  network: 'Solana mainnet',
  source: 'example.test',
  observedAt: new Date().toISOString(),
  feeSlot: 100,
  simulationSlot: 101,
  blockHeight: '100',
  networkFeeLamports: '5000',
  unitsConsumed: '1000',
  nativeChangeRaw: '-5000',
  tokensComplete: true,
  tokenChanges: [
    {
      mint: 'mint',
      program: 'program',
      decimals: 9,
      beforeRaw: '1',
      afterRaw: '0',
      changeRaw: '-1',
      accounts: ['account'],
    },
  ],
  inputAmountMatches: false,
  minimumOutputCovered: false,
  limitations: 'Unsigned simulation only.',
};
it('renders exact token changes and mismatched input and output without signing clearance', () => {
  const html = renderToStaticMarkup(
    <SimulatedSwapTokenBalances simulation={simulation} />,
  );
  expect(html).toContain('-0.000000001');
  expect(html).toContain('Raw change: -1');
  expect(html).toContain('does not match the requested input');
  expect(html).toContain('falls below the quoted minimum');
  expect(html).toContain(
    'do not verify instruction semantics or permit signing',
  );
});
it('distinguishes native comparison and missing provider token metadata', () => {
  const native = renderToStaticMarkup(
    <SimulatedSwapTokenBalances
      simulation={{
        ...simulation,
        inputAmountMatches: null,
        minimumOutputCovered: true,
      }}
    />,
  );
  expect(native).toContain('Comparison unavailable for native SOL');
  expect(native).toContain('covers the quoted minimum');
  const missing = renderToStaticMarkup(
    <SimulatedSwapTokenBalances
      simulation={{ ...simulation, tokensComplete: false, tokenChanges: [] }}
    />,
  );
  expect(missing).toContain('did not return complete token ownership metadata');
  expect(missing).not.toContain('covers the quoted minimum');
});
