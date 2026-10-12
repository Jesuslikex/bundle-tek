import { expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  importedSellAcquisitions,
  importedSellSourcePreview,
  importedSellBasketPlan,
} from './imported-sell-acquisitions';
import {
  acquisitionFixture,
  acquisitionId,
  acquisitionWallet,
  acquisitionReceipt,
} from '../test/imported-sell-acquisition-fixture';
import { importedLotPage, proposedImportedLotLink } from './imported-lot-links';
it('paginates complete receipt history beyond 50 and searches older revisions without losing the selected source', () => {
  const page = acquisitionFixture();
  const first = importedSellAcquisitions(page, acquisitionWallet);
  expect(first.total).toBe(55);
  expect(first.rows).toHaveLength(50);
  expect(first.rows[0].receipt.id).toBe(acquisitionId(56));
  const second = importedSellAcquisitions(page, acquisitionWallet, '', 1);
  expect(second.rows).toHaveLength(5);
  expect(second.rows.at(-1)!.receipt.id).toBe(acquisitionId(2));
  expect(
    importedSellAcquisitions(page, acquisitionWallet, acquisitionId(2)).rows,
  ).toHaveLength(1);
  expect(
    importedSellSourcePreview(page, acquisitionWallet, acquisitionId(2), '2'),
  ).toMatchObject({
    covered: true,
    unitsRaw: '2',
    allocatedCostLamports: '68',
    remainingAmount: '2',
  });
  expect(importedSellAcquisitions(page, acquisitionWallet, '', 99).index).toBe(
    1,
  );
});
it('uses remaining capacity after partial sales, rejects wrong-wallet and missing sources, and preserves exact max-unit arithmetic', () => {
  const page = acquisitionFixture(1);
  expect(
    importedSellSourcePreview(page, acquisitionWallet, acquisitionId(2), '3'),
  ).toMatchObject({
    covered: false,
    allocatedCostLamports: null,
    remainingAmount: '2',
  });
  for (const amount of ['0', '-1', '1.5'])
    expect(() =>
      importedSellSourcePreview(
        page,
        acquisitionWallet,
        acquisitionId(2),
        amount,
      ),
    ).toThrow();
  const other = bs58.encode(new Uint8Array(32).fill(8));
  expect(importedSellAcquisitions(page, other).total).toBe(0);
  expect(() =>
    importedSellSourcePreview(page, other, acquisitionId(2), '1'),
  ).toThrow();
  expect(() =>
    importedSellSourcePreview(page, acquisitionWallet, acquisitionId(9), '1'),
  ).toThrow();
  const max = (1n << 64n) - 1n;
  const buy = acquisitionReceipt(3, 'Buy', max.toString());
  const large = importedLotPage(
    {
      ...page,
      receipts: [buy],
      links: [],
      receiptDocumentHashes: { [buy.id]: 'b'.repeat(64) },
    },
    page.projectId,
    page.mint,
    0,
  );
  expect(
    importedSellSourcePreview(large, acquisitionWallet, buy.id, max.toString()),
  ).toMatchObject({
    covered: true,
    allocatedCostLamports: '101',
    remainingAmount: max.toString(),
  });
});
it('excludes fully assigned acquisitions while retaining a clear selected-source rejection', () => {
  const page = acquisitionFixture(1);
  const sale = acquisitionReceipt(101, 'Sell', '2', acquisitionWallet, 1001);
  const receipts = [...page.receipts, sale],
    links = [
      ...page.links,
      proposedImportedLotLink(
        receipts,
        page.links,
        page.projectId,
        acquisitionId(2),
        sale.id,
        acquisitionId(201),
        page.observedAt,
      ),
    ];
  const full = importedLotPage(
    {
      ...page,
      receipts,
      links,
      receiptDocumentHashes: {
        ...page.receiptDocumentHashes,
        [sale.id]: 'c'.repeat(64),
      },
    },
    page.projectId,
    page.mint,
    0,
  );
  expect(importedSellAcquisitions(full, acquisitionWallet).total).toBe(0);
  expect(
    importedSellSourcePreview(full, acquisitionWallet, acquisitionId(2), '1'),
  ).toMatchObject({ covered: false, remainingAmount: '0' });
});

it('builds exact multi-source allocations with individual remaining caps and an explicit parent amount match', () => {
  const page = acquisitionFixture(2),
    drafts = [
      { buyReceiptId: acquisitionId(3), amount: '1' },
      { buyReceiptId: acquisitionId(2), amount: '2' },
    ];
  expect(
    importedSellBasketPlan(page, acquisitionWallet, drafts, '3'),
  ).toMatchObject({
    totalRaw: '3',
    totalAmount: '3',
    allocatedCostLamports: '101',
    matches: true,
    allocations: [
      { buyReceiptId: acquisitionId(2), unitsRaw: '2' },
      { buyReceiptId: acquisitionId(3), unitsRaw: '1' },
    ],
  });
  expect(
    importedSellBasketPlan(page, acquisitionWallet, drafts, '4').matches,
  ).toBe(false);
  expect(
    importedSellBasketPlan(page, acquisitionWallet, drafts, 'invalid').matches,
  ).toBe(false);
  for (const bad of [
    [],
    [drafts[0]],
    [drafts[0], drafts[0]],
    [drafts[0], { ...drafts[1], amount: '3' }],
    [drafts[0], { ...drafts[1], amount: '0' }],
  ])
    expect(() =>
      importedSellBasketPlan(page, acquisitionWallet, bad, '3'),
    ).toThrow();
});
