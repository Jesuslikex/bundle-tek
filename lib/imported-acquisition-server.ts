import { importedAcquisitionSnapshot } from './imported-lot-links-server';
import {
  validatedImportedAcquisition,
  importedAcquisitionEntries,
  importedAcquisitionAllocations,
  validatedImportedAcquisitionSelection,
  type ImportedAcquisitionSelection,
  type ImportedAcquisitionBasket,
  type ImportedAcquisition,
} from './imported-acquisition';
import type { ImportedTradeReceipt } from './imported-trade-ledger';
export type ImportedSingleAcquisitionGuard = {
  selection: ImportedAcquisition;
  rawBuyDocument: string;
};
export async function captureImportedAcquisition(
  db: D1Database,
  owner: string,
  projectId: string,
  wallet: string,
  mint: string,
  decimals: number,
  buyReceiptId: string,
  unitsRaw: string,
): Promise<ImportedSingleAcquisitionGuard> {
  const snapshot = await importedAcquisitionSnapshot(db, owner, projectId);
  if (
    !snapshot ||
    snapshot.page.mint !== mint ||
    snapshot.page.decimals !== decimals
  )
    throw new Error('Acquisition project differs.');
  return captureFromSnapshot(
    snapshot,
    projectId,
    wallet,
    mint,
    decimals,
    buyReceiptId,
    unitsRaw,
  );
}
type AcquisitionSnapshot = NonNullable<
  Awaited<ReturnType<typeof importedAcquisitionSnapshot>>
>;
function captureFromSnapshot(
  snapshot: AcquisitionSnapshot,
  projectId: string,
  wallet: string,
  mint: string,
  decimals: number,
  buyReceiptId: string,
  unitsRaw: string,
): ImportedSingleAcquisitionGuard {
  const buy = snapshot.page.receipts.find((r) => r.id === buyReceiptId),
    lot = snapshot.page.performance.lots.find(
      (l) => l.buyReceiptId === buyReceiptId,
    );
  if (
    !buy ||
    !lot ||
    buy.document.wallet !== wallet ||
    buy.document.side !== 'Buy'
  )
    throw new Error('Acquisition unavailable.');
  const acquired = BigInt(lot.acquiredRaw),
    before = BigInt(lot.assignedSoldRaw),
    units = BigInt(unitsRaw),
    cost = BigInt(lot.buyCostLamports);
  const selection = validatedImportedAcquisition(
    {
      projectId,
      buyReceiptId,
      buySignature: buy.document.signature,
      buyPreparationSha256: buy.document.preparationSha256,
      buyDocumentSha256: snapshot.page.receiptDocumentHashes[buyReceiptId],
      wallet,
      mint,
      decimals,
      acquiredRaw: lot.acquiredRaw,
      assignedBeforeRaw: lot.assignedSoldRaw,
      unitsRaw,
      buyCostLamports: lot.buyCostLamports,
      allocatedCostLamports: (
        (cost * (before + units)) / acquired -
        (cost * before) / acquired
      ).toString(),
      linkRevision: snapshot.page.revision,
    },
    { projectId, wallet, mint, unitsRaw },
  );
  return {
    selection,
    rawBuyDocument: snapshot.stored.find((r) => r.id === buyReceiptId)!
      .document,
  };
}
export async function finalizeImportedAcquisition(
  db: D1Database,
  owner: string,
  selection: ImportedAcquisitionSelection,
  receipt: ImportedTradeReceipt,
  receiptWrite: D1PreparedStatement,
  intentWrite: D1PreparedStatement,
) {
  const a = validatedImportedAcquisitionSelection(selection, {
    projectId: receipt.projectId,
    wallet: receipt.document.wallet,
    mint: receipt.document.mint,
    unitsRaw: receipt.document.tokenUnitsRaw,
  });
  if (
    receipt.document.side !== 'Sell' ||
    receipt.document.decimals !== a.decimals
  )
    throw new Error('Acquisition requires a sell.');
  const guard = await currentImportedAcquisition(db, owner, a, true),
    nonce = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        'INSERT OR IGNORE INTO imported_trade_lot_gates(owner_id,project_id,revision) VALUES(?,?,0)',
      )
      .bind(owner, a.projectId),
    db
      .prepare(
        'UPDATE imported_trade_lot_gates SET revision=revision+1,write_token=? WHERE owner_id=? AND project_id=? AND revision=?',
      )
      .bind(nonce, owner, a.projectId, guard.selection.linkRevision),
    receiptWrite,
    ...importedAcquisitionEntries(a).map((part) =>
      db
        .prepare(
          'INSERT INTO imported_trade_lot_links(id,owner_id,project_id,buy_receipt_id,sell_receipt_id,units_raw,buy_signature,sell_signature,buy_preparation_sha256,sell_preparation_sha256,created_at,write_token) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          crypto.randomUUID(),
          owner,
          a.projectId,
          part.buyReceiptId,
          receipt.id,
          part.unitsRaw,
          part.buySignature,
          receipt.document.signature,
          part.buyPreparationSha256,
          receipt.document.preparationSha256,
          receipt.createdAt,
          nonce,
        ),
    ),
    intentWrite,
  ]);
}
export function currentImportedAcquisition(
  db: D1Database,
  owner: string,
  selection: ImportedAcquisition,
  allowUnrelatedLedgerChanges?: boolean,
): Promise<ImportedSingleAcquisitionGuard>;
export function currentImportedAcquisition(
  db: D1Database,
  owner: string,
  selection: ImportedAcquisitionBasket,
  allowUnrelatedLedgerChanges?: boolean,
): Promise<ImportedAcquisitionBasketGuard>;
export function currentImportedAcquisition(
  db: D1Database,
  owner: string,
  selection: ImportedAcquisitionSelection,
  allowUnrelatedLedgerChanges?: boolean,
): Promise<ImportedAcquisitionGuard>;
export async function currentImportedAcquisition(
  db: D1Database,
  owner: string,
  selection: ImportedAcquisitionSelection,
  allowUnrelatedLedgerChanges = false,
) {
  const a = validatedImportedAcquisitionSelection(selection, {
    projectId: selection.projectId,
    wallet: selection.wallet,
    mint: selection.mint,
    unitsRaw: selection.unitsRaw,
  });
  if ('kind' in a)
    return currentImportedAcquisitionBasket(
      db,
      owner,
      a,
      allowUnrelatedLedgerChanges,
    );
  const guard = await captureImportedAcquisition(
    db,
    owner,
    a.projectId,
    a.wallet,
    a.mint,
    a.decimals,
    a.buyReceiptId,
    a.unitsRaw,
  );
  if (
    JSON.stringify({
      ...guard.selection,
      linkRevision: allowUnrelatedLedgerChanges
        ? a.linkRevision
        : guard.selection.linkRevision,
    }) !== JSON.stringify(a)
  )
    throw new Error('Acquisition changed. Prepare and review again.');
  return guard;
}

export type ImportedAcquisitionBasketGuard = {
  selection: ImportedAcquisitionBasket;
  sources: ImportedSingleAcquisitionGuard[];
};
export async function captureImportedAcquisitionBasket(
  db: D1Database,
  owner: string,
  projectId: string,
  wallet: string,
  mint: string,
  decimals: number,
  allocations: unknown,
  unitsRaw: string,
): Promise<ImportedAcquisitionBasketGuard> {
  const parts = importedAcquisitionAllocations(allocations, unitsRaw);
  const snapshot = await importedAcquisitionSnapshot(db, owner, projectId);
  if (
    !snapshot ||
    snapshot.page.mint !== mint ||
    snapshot.page.decimals !== decimals
  )
    throw new Error('Acquisition project differs.');
  const sources = parts.map((part) =>
    captureFromSnapshot(
      snapshot,
      projectId,
      wallet,
      mint,
      decimals,
      part.buyReceiptId,
      part.unitsRaw,
    ),
  );
  const selection: ImportedAcquisitionBasket = {
    kind: 'basket',
    version: 1,
    projectId,
    wallet,
    mint,
    decimals,
    unitsRaw,
    linkRevision: snapshot.page.revision,
    allocations: sources.map((s) => s.selection),
  };
  validatedImportedAcquisitionSelection(selection, {
    projectId,
    wallet,
    mint,
    unitsRaw,
  });
  return { selection, sources };
}

export async function currentImportedAcquisitionBasket(
  db: D1Database,
  owner: string,
  a: ImportedAcquisitionBasket,
  allowUnrelatedLedgerChanges = false,
): Promise<ImportedAcquisitionBasketGuard> {
  validatedImportedAcquisitionSelection(a, {
    projectId: a.projectId,
    wallet: a.wallet,
    mint: a.mint,
    unitsRaw: a.unitsRaw,
  });
  const guard = await captureImportedAcquisitionBasket(
    db,
    owner,
    a.projectId,
    a.wallet,
    a.mint,
    a.decimals,
    a.allocations.map(({ buyReceiptId, unitsRaw }) => ({
      buyReceiptId,
      unitsRaw,
    })),
    a.unitsRaw,
  );
  const current = allowUnrelatedLedgerChanges
    ? {
        ...guard.selection,
        linkRevision: a.linkRevision,
        allocations: guard.selection.allocations.map((part) => ({
          ...part,
          linkRevision: a.linkRevision,
        })),
      }
    : guard.selection;
  if (JSON.stringify(current) !== JSON.stringify(a))
    throw new Error('Acquisition changed. Prepare and review again.');
  return guard;
}

export type ImportedAcquisitionGuard =
  | ImportedSingleAcquisitionGuard
  | ImportedAcquisitionBasketGuard;
export function importedAcquisitionGuardSources(
  guard: ImportedAcquisitionGuard,
) {
  return 'sources' in guard ? guard.sources : [guard];
}
export function importedAcquisitionWriteGuard(
  owner: string,
  guard?: ImportedAcquisitionGuard,
) {
  if (!guard) return { sql: '', bindings: [] as (string | number)[] };
  const a = validatedImportedAcquisitionSelection(guard.selection, {
    projectId: guard.selection.projectId,
    wallet: guard.selection.wallet,
    mint: guard.selection.mint,
    unitsRaw: guard.selection.unitsRaw,
  });
  const sources = importedAcquisitionGuardSources(guard);
  if (
    JSON.stringify(sources.map((s) => s.selection)) !==
    JSON.stringify(importedAcquisitionEntries(a))
  )
    throw new Error('Acquisition guard sources differ.');
  return {
    sql:
      sources
        .map(
          () =>
            ' AND EXISTS(SELECT 1 FROM imported_swap_receipts WHERE owner_id=? AND id=? AND project_id=? AND document=?)',
        )
        .join('') +
      ' AND COALESCE((SELECT revision FROM imported_trade_lot_gates WHERE owner_id=? AND project_id=?),0)=?',
    bindings: [
      ...sources.flatMap((s) => [
        owner,
        s.selection.buyReceiptId,
        a.projectId,
        s.rawBuyDocument,
      ]),
      owner,
      a.projectId,
      a.linkRevision,
    ],
  };
}
