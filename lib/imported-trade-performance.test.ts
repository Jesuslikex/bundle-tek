import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { importedTradePerformance } from './imported-trade-performance';
import { validatedImportedPerformance } from './imported-performance-format';
import {
  summarizeImportedTrades,
  type ImportedTradeReceipt,
} from './imported-trade-ledger';
const projectId = crypto.randomUUID(),
  mint = bs58.encode(new Uint8Array(32).fill(2));
it('includes bundle expenses in FIFO basis and net proceeds without losing partial-sale rounding', () => {
  const rows = [
    receipt('Buy', 1, '3'),
    receipt('Sell', 2, '1'),
    receipt('Sell', 3, '2', '90'),
  ];
  const expenses = {
    executionCosts: { [rows[0].id]: '5', [rows[1].id]: '7', [rows[2].id]: '1' },
    bundleTipLamports: '10',
    bundleFeeLamports: '3',
    missingBundleCostCount: 0,
  };
  const p = importedTradePerformance(rows, expenses);
  expect(p).toMatchObject({
    realizedCostLamports: '106',
    attributedNetProceedsLamports: '130',
    realizedResultLamports: '24',
    openCostLamports: '0',
    bundleTipLamports: '10',
    bundleFeeLamports: '3',
  });
  const partial = importedTradePerformance(rows.slice(0, 2), {
    ...expenses,
    executionCosts: { [rows[0].id]: '5', [rows[1].id]: '7' },
    bundleFeeLamports: '2',
  });
  expect(partial).toMatchObject({
    realizedCostLamports: '35',
    openCostLamports: '71',
    realizedResultLamports: '7',
  });
  const missing = importedTradePerformance(rows, {
    ...expenses,
    missingBundleCostCount: 1,
  });
  expect(missing.realizedResultLamports).toBeNull();
  expect(missing.wallets[0].realizedResultLamports).toBeNull();
  expect(() =>
    validatedImportedPerformance(
      { ...missing, realizedResultLamports: '24' },
      3,
      '3',
      '3',
    ),
  ).toThrow();
  expect(() =>
    importedTradePerformance(rows, { ...expenses, bundleTipLamports: '11' }),
  ).toThrow('allocation');
});
function receipt(
  side: 'Buy' | 'Sell',
  slot: number,
  units = '3',
  settlement = side === 'Buy' ? '-100' : '50',
  wallet = bs58.encode(new Uint8Array(32).fill(3)),
): ImportedTradeReceipt {
  return {
    id: crypto.randomUUID(),
    projectId,
    preparationId: crypto.randomUUID(),
    projectRevision: 1,
    walletRevision: 1,
    createdAt: '2026-10-11T00:00:00.000Z',
    document: {
      network: 'mainnet',
      mint,
      decimals: 6,
      preparationSha256: 'a'.repeat(64),
      signature: bs58.encode(new Uint8Array(64).fill(slot)),
      wallet,
      signatureVerified: true,
      commitment: 'finalized',
      side,
      tokenUnitsRaw: units,
      source: 'provider.test',
      observedAt: '2026-10-11T00:00:00.000Z',
      slot,
      blockTime: null,
      networkFeeLamports: '1',
      nativeChangeRaw: settlement,
      rentChangeRaw: '20',
      nativeSettlementRaw: settlement,
    },
  };
}
it('keeps empty and unsold history separate from estimates and excludes rent from buy cost', () => {
  expect(importedTradePerformance([])).toMatchObject({
    receiptCount: 0,
    realizedResultLamports: null,
    openCostLamports: '0',
  });
  expect(importedTradePerformance([receipt('Buy', 1)])).toMatchObject({
    realizedResultLamports: null,
    openCostLamports: '101',
    recordedOpenRaw: '3',
  });
});
it('uses the earliest recorded buy with cumulative exact cost across lots and partial sells', () => {
  const b1 = receipt('Buy', 1),
    b2 = receipt('Buy', 2, '2', '-200'),
    s = receipt('Sell', 3, '4', '300');
  expect(importedTradePerformance([s, b2, b1])).toMatchObject({
    realizedCostLamports: '201',
    attributedNetProceedsLamports: '299',
    realizedResultLamports: '98',
    openCostLamports: '101',
    recordedOpenRaw: '1',
  });
});
it('consumes all cost rounding residue on full exits and preserves negative proceeds after fees', () => {
  const rows = [
    receipt('Buy', 1),
    receipt('Sell', 2, '1'),
    receipt('Sell', 3, '1'),
    receipt('Sell', 4, '1'),
  ];
  expect(importedTradePerformance(rows.reverse())).toMatchObject({
    realizedCostLamports: '101',
    realizedResultLamports: '46',
    openCostLamports: '0',
  });
  const s = receipt('Sell', 2);
  s.document.networkFeeLamports = '60';
  expect(
    importedTradePerformance([receipt('Buy', 1), s]).realizedResultLamports,
  ).toBe('-111');
});
it('never matches other wallets or later buys and does not treat unknown-basis proceeds as gains', () => {
  const wallet = bs58.encode(new Uint8Array(32).fill(4));
  const p = importedTradePerformance([
    receipt('Sell', 1),
    receipt('Buy', 2),
    receipt('Sell', 3, '3', '50', wallet),
  ]);
  expect(p).toMatchObject({
    unknownBasisSoldRaw: '6',
    matchedSoldRaw: '0',
    realizedResultLamports: null,
    attributedResultLamports: '0',
    openCostLamports: '101',
  });
});
it('withholds aggregate results on partly unmatched sells while retaining accounted quantities', () => {
  expect(
    importedTradePerformance([
      receipt('Buy', 1),
      receipt('Sell', 2, '4', '200'),
    ]),
  ).toMatchObject({
    matchedSoldRaw: '3',
    unknownBasisSoldRaw: '1',
    attributedNetProceedsLamports: '149',
    realizedCostLamports: '101',
    realizedResultLamports: null,
  });
});
it('withholds wallets with same-slot ambiguity instead of sorting by IDs or receipt timestamps', () => {
  const other = bs58.encode(new Uint8Array(32).fill(4));
  const b = receipt('Buy', 1),
    s = receipt('Sell', 2);
  s.document.slot = 1;
  const p = importedTradePerformance([
    s,
    b,
    receipt('Buy', 3, '3', '-100', other),
    receipt('Sell', 4, '3', '200', other),
  ]);
  expect(p).toMatchObject({
    unresolvedSoldRaw: '3',
    matchedSoldRaw: '3',
    realizedResultLamports: null,
    openCostLamports: null,
  });
  expect(
    p.wallets.find((w) => w.wallet === other)?.realizedResultLamports,
  ).toBe('98');
  expect(p.wallets.find((w) => w.wallet === b.document.wallet)).toMatchObject({
    ordering: 'unavailable',
    recordedOpenRaw: null,
  });
});
it('keeps large token and lamport integers exact', () => {
  expect(
    importedTradePerformance([
      receipt('Buy', 1, '9007199254740993', '-9007199254740993'),
      receipt('Sell', 2, '9007199254740992', '9007199254740993'),
    ]),
  ).toMatchObject({
    realizedCostLamports: '9007199254740992',
    realizedResultLamports: '0',
    openCostLamports: '2',
    recordedOpenRaw: '1',
  });
});
it('rejects incomplete, duplicate, wrong-mint or over-capacity evidence and inconsistent response totals', () => {
  const b = receipt('Buy', 1);
  expect(() => importedTradePerformance([b, b])).toThrow();
  expect(() => importedTradePerformance(Array(4001).fill(b))).toThrow();
  const wrong = receipt('Sell', 2);
  wrong.document.mint = bs58.encode(new Uint8Array(32).fill(9));
  expect(() => importedTradePerformance([b, wrong])).toThrow();
  const broken = receipt('Buy', 1);
  broken.document.networkFeeLamports = 'NaN';
  expect(() => importedTradePerformance([broken])).toThrow();
  const rows = [b, receipt('Sell', 2)],
    p = importedTradePerformance(rows),
    summary = summarizeImportedTrades(rows);
  for (const patch of [
    { realizedResultLamports: '49' },
    { matchedSoldRaw: '4' },
    { openCostLamports: '1' },
    { method: 'inferred' },
    { wallets: [...p.wallets, ...p.wallets] },
  ])
    expect(() =>
      validatedImportedPerformance(
        { ...p, ...patch },
        summary.receiptCount,
        summary.boughtRaw,
        summary.soldRaw,
      ),
    ).toThrow();
});
