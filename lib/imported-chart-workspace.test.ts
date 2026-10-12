import { expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  finalizedReceiptChartTarget,
  importedChartWorkspaceId,
} from './imported-chart-workspace';
import type { ImportedSwapReceipt } from './imported-approval-history';
import { supplyWallet } from '../test/supply-history-fixture';
export const chartReceipt: ImportedSwapReceipt = {
  id: 'receipt-1',
  projectId: 'supply-project-1',
  preparationId: 'preparation-1',
  projectRevision: 1,
  walletRevision: 1,
  createdAt: '2026-10-11T12:00:00Z',
  document: {
    network: 'mainnet',
    mint: supplyWallet(9),
    decimals: 6,
    preparationSha256: 'a'.repeat(64),
    signature: bs58.encode(new Uint8Array(64).fill(1)),
    wallet: supplyWallet(1),
    signatureVerified: true,
    commitment: 'finalized',
    side: 'Buy',
    tokenUnitsRaw: '10000',
    source: 'fixture.test',
    observedAt: '2026-10-11T12:00:00Z',
  },
};
it('routes finalized buys and sells to their project chart', () => {
  expect(finalizedReceiptChartTarget(chartReceipt)).toBe(
    'imported-chart-supply-project-1',
  );
  expect(
    finalizedReceiptChartTarget({
      ...chartReceipt,
      document: { ...chartReceipt.document, side: 'Sell' },
    }),
  ).toBe('imported-chart-supply-project-1');
});
it.each([
  'signatureVerified',
  'commitment',
  'network',
  'signature',
  'mint',
  'tokenUnitsRaw',
])('rejects incomplete or mismatched receipt %s', (key) => {
  const receipt = structuredClone(chartReceipt);
  Object.assign(receipt.document, {
    [key]: key === 'signatureVerified' ? false : 'invalid',
  });
  expect(finalizedReceiptChartTarget(receipt)).toBeNull();
});
it('rejects unsafe project identities and zero acquired units', () => {
  expect(() => importedChartWorkspaceId('foreign#chart')).toThrow();
  expect(
    finalizedReceiptChartTarget({
      ...chartReceipt,
      document: { ...chartReceipt.document, tokenUnitsRaw: '0' },
    }),
  ).toBeNull();
});
