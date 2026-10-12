import { beforeEach, expect, it, vi } from 'vitest';
import {
  acquisitionFixture,
  acquisitionId,
  acquisitionWallet,
} from '../test/imported-sell-acquisition-fixture';
import { acquisitionBasketFixture } from '../test/imported-acquisition-basket-fixture';
const snapshotRead = vi.hoisted(() => vi.fn());
vi.mock('./imported-lot-links-server', () => ({
  importedAcquisitionSnapshot: snapshotRead,
}));
import {
  captureImportedAcquisitionBasket,
  currentImportedAcquisitionBasket,
  currentImportedAcquisition,
} from './imported-acquisition-server';
const db = {} as D1Database;
function snapshot() {
  const page = acquisitionFixture(2);
  return {
    page,
    stored: page.receipts.map((r) => ({
      ...r,
      document: JSON.stringify(r.document),
    })),
  };
}
async function capture(
  allocations: unknown = [
    { buyReceiptId: acquisitionId(3), unitsRaw: '1' },
    { buyReceiptId: acquisitionId(2), unitsRaw: '2' },
  ],
  unitsRaw = '3',
  wallet = acquisitionWallet,
) {
  const page = acquisitionFixture(2);
  return captureImportedAcquisitionBasket(
    db,
    'owner',
    page.projectId,
    wallet,
    page.mint,
    page.decimals,
    allocations,
    unitsRaw,
  );
}
beforeEach(() => {
  snapshotRead.mockReset();
  snapshotRead.mockResolvedValue(snapshot());
});
it('captures every source and original document from one coherent owner/project snapshot', async () => {
  const guard = await capture();
  expect(snapshotRead).toHaveBeenCalledExactlyOnceWith(
    db,
    'owner',
    acquisitionId(1),
  );
  expect(guard.selection).toEqual(acquisitionBasketFixture());
  expect(
    await currentImportedAcquisition(db, 'owner', guard.selection),
  ).toEqual(guard);
  expect(guard.sources).toHaveLength(2);
  expect(guard.sources.map((s) => s.selection.buyReceiptId)).toEqual([
    acquisitionId(2),
    acquisitionId(3),
  ]);
  for (const source of guard.sources) {
    const raw = JSON.parse(source.rawBuyDocument);
    expect(raw.signature).toBe(source.selection.buySignature);
    expect(raw.tokenUnitsRaw).toBe(source.selection.acquiredRaw);
  }
});
it('rejects invalid allocations before reading any snapshot', async () => {
  await expect(
    capture([
      { buyReceiptId: acquisitionId(2), unitsRaw: '1' },
      { buyReceiptId: acquisitionId(2), unitsRaw: '2' },
    ]),
  ).rejects.toThrow();
  await expect(capture(undefined, '4')).rejects.toThrow();
  expect(snapshotRead).not.toHaveBeenCalled();
});
it('rejects a missing, wrong-wallet or overallocated source and an unavailable project', async () => {
  await expect(
    capture(
      [
        { buyReceiptId: acquisitionId(2), unitsRaw: '3' },
        { buyReceiptId: acquisitionId(3), unitsRaw: '1' },
      ],
      '4',
    ),
  ).rejects.toThrow();
  await expect(
    capture([
      { buyReceiptId: acquisitionId(2), unitsRaw: '2' },
      { buyReceiptId: acquisitionId(999), unitsRaw: '1' },
    ]),
  ).rejects.toThrow();
  await expect(
    capture(undefined, '3', acquisitionFixture(2).mint),
  ).rejects.toThrow();
  snapshotRead.mockResolvedValueOnce(null);
  await expect(capture()).rejects.toThrow();
});
it('rechecks every captured source and only permits unrelated ledger revision changes when explicitly requested', async () => {
  const a = acquisitionBasketFixture();
  const unrelated = snapshot();
  unrelated.page.revision = 2;
  snapshotRead.mockResolvedValue(unrelated);
  await expect(
    currentImportedAcquisitionBasket(db, 'owner', a),
  ).rejects.toThrow('Acquisition changed');
  const fresh = await currentImportedAcquisitionBasket(db, 'owner', a, true);
  expect(fresh.selection.linkRevision).toBe(2);
  expect(fresh.selection.allocations.map((p) => p.linkRevision)).toEqual([
    2, 2,
  ]);
  expect(a.linkRevision).toBe(1);
  for (const index of [0, 1]) {
    const changed = snapshot();
    changed.page.revision = 2;
    changed.page.receiptDocumentHashes[a.allocations[index].buyReceiptId] =
      'c'.repeat(64);
    snapshotRead.mockResolvedValue(changed);
    await expect(
      currentImportedAcquisitionBasket(db, 'owner', a, true),
    ).rejects.toThrow('Acquisition changed');
    const consumed = snapshot();
    consumed.page.performance.lots[index].assignedSoldRaw = '3';
    snapshotRead.mockResolvedValue(consumed);
    await expect(
      currentImportedAcquisitionBasket(db, 'owner', a, true),
    ).rejects.toThrow();
  }
});
