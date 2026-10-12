import { it, expect } from 'vitest';
import bs58 from 'bs58';
import {
  importedLinkedPerformance,
  importedLotPage,
  proposedImportedLotLink,
} from './imported-lot-links';
import type { ImportedTradeReceipt } from './imported-trade-ledger';
const id = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  key = bs58.encode(new Uint8Array(32).fill(1));
const receipt = (
  n: number,
  side: 'Buy' | 'Sell',
  units: string,
): ImportedTradeReceipt => ({
  id: id(n),
  projectId: id(1),
  preparationId: id(n + 100),
  projectRevision: 1,
  walletRevision: 1,
  createdAt: '2026-10-11T00:00:00Z',
  document: {
    network: 'mainnet',
    mint: key,
    decimals: 6,
    preparationSha256: 'a'.repeat(64),
    signature: bs58.encode(new Uint8Array(64).fill(n)),
    wallet: key,
    signatureVerified: true,
    commitment: 'finalized',
    side,
    tokenUnitsRaw: units,
    source: 'provider.test',
    observedAt: '2026-10-11T00:00:00Z',
    slot: n,
    blockTime: null,
    networkFeeLamports: '1',
    nativeChangeRaw: side === 'Buy' ? '-101' : '49',
    rentChangeRaw: '0',
    nativeSettlementRaw: side === 'Buy' ? '-100' : '50',
  },
});
it('keeps unlinked sales unresolved and refuses altered links or context', () => {
  const rows = [receipt(2, 'Buy', '3'), receipt(3, 'Sell', '1')];
  expect(importedLinkedPerformance(rows, []).realizedResultLamports).toBeNull();
  const link = proposedImportedLotLink(
    rows,
    [],
    id(1),
    id(2),
    id(3),
    id(500),
    '2026-10-11T00:00:00Z',
  );
  expect(importedLinkedPerformance(rows, [link]).realizedResultLamports).toBe(
    '16',
  );
  expect(() =>
    importedLinkedPerformance(rows, [{ ...link, unitsRaw: '2' }]),
  ).toThrow();
  expect(() =>
    importedLinkedPerformance(rows, [
      { ...link, buySignature: link.sellSignature },
    ]),
  ).toThrow();
  expect(() => importedLinkedPerformance(rows, [link, link])).toThrow();
  expect(() =>
    proposedImportedLotLink(
      rows,
      [link],
      id(1),
      id(2),
      id(3),
      id(501),
      link.createdAt,
    ),
  ).toThrow();
  expect(() =>
    importedLotPage(
      {
        projectId: id(1),
        mint: key,
        decimals: 6,
        revision: 0,
        receipts: rows,
        links: [link],
        observedAt: link.createdAt,
      },
      id(9),
      key,
      6,
    ),
  ).toThrow();
});
it('allocates full rounding residue without guessing same-slot acquisition order', () => {
  const rows = [
    receipt(2, 'Buy', '3'),
    receipt(3, 'Sell', '1'),
    receipt(4, 'Sell', '2'),
  ];
  const a = proposedImportedLotLink(
    rows,
    [],
    id(1),
    id(2),
    id(3),
    id(500),
    '2026-10-11T00:00:00Z',
  );
  const b = proposedImportedLotLink(
    rows,
    [a],
    id(1),
    id(2),
    id(4),
    id(501),
    a.createdAt,
  );
  expect(importedLinkedPerformance(rows, [b, a])).toMatchObject({
    assignedCostLamports: '101',
    unassignedCostLamports: '0',
    realizedResultLamports: '-3',
  });
  rows[0].document.slot = 3;
  expect(() => importedLinkedPerformance(rows, [a])).toThrow();
});

it('apportions one sale and its fee across multiple sources exactly and independently of input order', () => {
  const rows = [
    receipt(2, 'Buy', '3'),
    receipt(3, 'Buy', '3'),
    receipt(4, 'Sell', '3'),
  ];
  const make = (buy: ImportedTradeReceipt, n: number, unitsRaw: string) => ({
    id: id(n),
    projectId: id(1),
    buyReceiptId: buy.id,
    sellReceiptId: rows[2].id,
    unitsRaw,
    buySignature: buy.document.signature,
    sellSignature: rows[2].document.signature,
    buyPreparationSha256: buy.document.preparationSha256,
    sellPreparationSha256: rows[2].document.preparationSha256,
    createdAt: rows[2].createdAt,
  });
  const links = [make(rows[0], 500, '2'), make(rows[1], 501, '1')];
  const result = importedLinkedPerformance(rows, links);
  expect(result).toMatchObject({
    linkedSaleCount: 1,
    unlinkedSaleCount: 0,
    assignedCostLamports: '100',
    netAssignedProceedsLamports: '49',
    realizedResultLamports: '-51',
  });
  expect(result.lots.map((l) => l.netAssignedProceedsLamports)).toEqual([
    '32',
    '17',
  ]);
  expect(importedLinkedPerformance(rows, [...links].reverse())).toEqual(result);
  expect(links.map((l) => l.buyReceiptId)).toEqual([rows[0].id, rows[1].id]);
  rows[2].document.networkFeeLamports = '51';
  const negative = importedLinkedPerformance(rows, links);
  expect(negative.netAssignedProceedsLamports).toBe('-1');
  expect(negative.lots.map((l) => l.netAssignedProceedsLamports)).toEqual([
    '0',
    '-1',
  ]);
  expect(negative.realizedResultLamports).toBe('-101');
  for (const invalid of [
    [links[0]],
    [links[1]],
    [...links, { ...links[1], id: id(502) }],
    [links[0], { ...links[1], unitsRaw: '2' }],
    [links[0], { ...links[1], unitsRaw: '0' }],
    [links[0], { ...links[1], unitsRaw: '01' }],
    [links[0], { ...links[1], unitsRaw: '18446744073709551616' }],
  ])
    expect(() => importedLinkedPerformance(rows, invalid)).toThrow();
  rows[1].document.tokenUnitsRaw = '1';
  expect(importedLinkedPerformance(rows, links).lots[1].unassignedRaw).toBe(
    '0',
  );
  rows[1].document.tokenUnitsRaw = '0';
  expect(() => importedLinkedPerformance(rows, links)).toThrow();
});
it('preserves exact split proceeds and residue at u64-scale without counting the fee twice', () => {
  const max = (1n << 64n) - 1n;
  const rows = [
    receipt(2, 'Buy', max.toString()),
    receipt(3, 'Buy', max.toString()),
    receipt(4, 'Sell', max.toString()),
  ];
  rows[2].document.nativeSettlementRaw = max.toString();
  rows[2].document.networkFeeLamports = '2';
  const links = rows.slice(0, 2).map((buy, i) => ({
    id: id(500 + i),
    projectId: id(1),
    buyReceiptId: buy.id,
    sellReceiptId: rows[2].id,
    unitsRaw: i === 0 ? (max - 1n).toString() : '1',
    buySignature: buy.document.signature,
    sellSignature: rows[2].document.signature,
    buyPreparationSha256: buy.document.preparationSha256,
    sellPreparationSha256: rows[2].document.preparationSha256,
    createdAt: rows[2].createdAt,
  }));
  const result = importedLinkedPerformance(rows, links);
  expect(result.netAssignedProceedsLamports).toBe((max - 2n).toString());
  expect(result.lots.map((l) => l.netAssignedProceedsLamports)).toEqual([
    (max - 3n).toString(),
    '1',
  ]);
  expect(result.linkedSaleCount).toBe(1);
  expect(result.assignedCostLamports).toBe('100');
});
