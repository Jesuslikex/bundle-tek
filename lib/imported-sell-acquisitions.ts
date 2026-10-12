import { importedAcquisitionAllocations } from './imported-acquisition';
import type { ImportedLotPage } from './imported-lot-links';
import { solanaTokenAtoms } from './solana-token-amount';
import { formatNativeBalance } from './wallet-balance-format';
export const IMPORTED_ACQUISITION_PAGE_SIZE = 50;
export function importedSellAcquisitions(
  page: ImportedLotPage,
  wallet: string,
  search = '',
  index = 0,
) {
  if (!Number.isSafeInteger(index) || index < 0)
    throw new Error('Invalid acquisition page.');
  const term = search.trim().toLowerCase(),
    receipts = new Map(page.receipts.map((r) => [r.id, r]));
  const rows = page.performance.lots
    .filter((l) => l.wallet === wallet && BigInt(l.unassignedRaw) > 0n)
    .map((l) => ({ lot: l, receipt: receipts.get(l.buyReceiptId)! }))
    .filter(
      (r) =>
        !term ||
        [
          r.receipt.id,
          r.receipt.document.signature,
          String(r.receipt.projectRevision),
        ].some((v) => v.toLowerCase().includes(term)),
    )
    .sort(
      (a, b) =>
        b.receipt.document.slot - a.receipt.document.slot ||
        b.receipt.id.localeCompare(a.receipt.id),
    );
  const pages = Math.max(
      1,
      Math.ceil(rows.length / IMPORTED_ACQUISITION_PAGE_SIZE),
    ),
    current = Math.min(index, pages - 1);
  return {
    total: rows.length,
    pages,
    index: current,
    rows: rows.slice(
      current * IMPORTED_ACQUISITION_PAGE_SIZE,
      (current + 1) * IMPORTED_ACQUISITION_PAGE_SIZE,
    ),
  };
}
export function importedSellSourcePreview(
  page: ImportedLotPage,
  wallet: string,
  receiptId: string,
  amount: string,
) {
  const { buy, lot, remainingAmount } = importedSellSource(
    page,
    wallet,
    receiptId,
  );
  const units = solanaTokenAtoms(amount, page.decimals),
    capacity = BigInt(lot.unassignedRaw),
    before = BigInt(lot.assignedSoldRaw),
    cost = BigInt(lot.buyCostLamports),
    acquired = BigInt(lot.acquiredRaw);
  if (units <= 0n) throw new Error('Enter a positive exact sell amount.');
  return {
    buy,
    lot,
    unitsRaw: units.toString(),
    covered: units <= capacity,
    allocatedCostLamports:
      units <= capacity
        ? (
            (cost * (before + units)) / acquired -
            (cost * before) / acquired
          ).toString()
        : null,
    remainingAmount,
  };
}

export function importedSellSource(
  page: ImportedLotPage,
  wallet: string,
  receiptId: string,
) {
  const buy = page.receipts.find((r) => r.id === receiptId),
    lot = page.performance.lots.find((l) => l.buyReceiptId === receiptId);
  if (
    !buy ||
    !lot ||
    buy.document.side !== 'Buy' ||
    buy.document.wallet !== wallet ||
    lot.wallet !== wallet
  )
    throw new Error('Selected acquisition is unavailable for this wallet.');
  return {
    buy,
    lot,
    remainingAmount: formatNativeBalance(lot.unassignedRaw, page.decimals),
  };
}

export type ImportedSellAllocationDraft = {
  buyReceiptId: string;
  amount: string;
};
export function importedSellBasketPlan(
  page: ImportedLotPage,
  wallet: string,
  drafts: ImportedSellAllocationDraft[],
  amount: string,
) {
  const sources = drafts.map((d) =>
    importedSellSourcePreview(page, wallet, d.buyReceiptId, d.amount),
  );
  if (sources.some((s) => !s.covered))
    throw new Error(
      'An allocation exceeds its buy receipt’s remaining recorded units.',
    );
  const totalRaw = sources
    .reduce((sum, s) => sum + BigInt(s.unitsRaw), 0n)
    .toString();
  const allocations = importedAcquisitionAllocations(
    sources.map((s) => ({ buyReceiptId: s.buy.id, unitsRaw: s.unitsRaw })),
    totalRaw,
  );
  let matches = false;
  try {
    matches = solanaTokenAtoms(amount, page.decimals).toString() === totalRaw;
  } catch {}
  return {
    sources,
    allocations,
    totalRaw,
    totalAmount: formatNativeBalance(totalRaw, page.decimals),
    allocatedCostLamports: sources
      .reduce((sum, s) => sum + BigInt(s.allocatedCostLamports!), 0n)
      .toString(),
    matches,
  };
}
