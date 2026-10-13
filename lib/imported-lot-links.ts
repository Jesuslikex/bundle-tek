import { IMPORTED_ACQUISITION_MAX_SOURCES } from './imported-acquisition';
import {
  importedTradeReceipt,
  summarizeImportedTrades,
  IMPORTED_LEDGER_LIMIT,
  type ImportedTradeReceipt,
} from './imported-trade-ledger';
import { UUID } from './wallet-operation';
import {
  validatedBundleExpenses,
  type BundleExpenses,
} from './bundle-expenses';
export const IMPORTED_LOT_LINK_LIMIT =
  IMPORTED_LEDGER_LIMIT * IMPORTED_ACQUISITION_MAX_SOURCES;
export type ImportedLotLink = {
  id: string;
  projectId: string;
  buyReceiptId: string;
  sellReceiptId: string;
  unitsRaw: string;
  buySignature: string;
  sellSignature: string;
  buyPreparationSha256: string;
  sellPreparationSha256: string;
  createdAt: string;
};
export function importedLinkedPerformance(
  receipts: ImportedTradeReceipt[],
  links: ImportedLotLink[],
  executionCosts: Record<string, string> = {},
) {
  summarizeImportedTrades(receipts);
  if (
    links.length > IMPORTED_LOT_LINK_LIMIT ||
    new Set(links.map((l) => l.id)).size !== links.length ||
    new Set(links.map((l) => l.sellReceiptId + ':' + l.buyReceiptId)).size !==
      links.length
  )
    throw new Error('Complete unique acquisition links required.');
  const first = receipts[0];
  for (const row of receipts)
    importedTradeReceipt(
      row,
      first.projectId,
      first.document.mint,
      first.document.decimals,
    );
  const byId = new Map(receipts.map((r) => [r.id, r]));
  for (const [id, cost] of Object.entries(executionCosts))
    if (!byId.has(id) || !/^(0|[1-9]\d{0,24})$/.test(cost))
      throw new Error('Execution cost context differs.');
  const totals = new Map<
    string,
    { units: bigint; proceeds: bigint; sells: number }
  >();
  for (const link of links) {
    const buy = byId.get(link.buyReceiptId),
      sell = byId.get(link.sellReceiptId);
    if (
      !UUID.test(link.id) ||
      !Number.isFinite(Date.parse(link.createdAt)) ||
      !buy ||
      !sell ||
      link.projectId !== buy.projectId ||
      sell.projectId !== buy.projectId ||
      buy.document.side !== 'Buy' ||
      sell.document.side !== 'Sell' ||
      buy.document.wallet !== sell.document.wallet ||
      buy.document.slot >= sell.document.slot ||
      !/^[1-9]\d{0,19}$/.test(link.unitsRaw) ||
      BigInt(link.unitsRaw) > BigInt(sell.document.tokenUnitsRaw) ||
      link.buySignature !== buy.document.signature ||
      link.sellSignature !== sell.document.signature ||
      link.buyPreparationSha256 !== buy.document.preparationSha256 ||
      link.sellPreparationSha256 !== sell.document.preparationSha256
    )
      throw new Error('Acquisition link evidence differs.');
  }
  const bySale = new Map<string, ImportedLotLink[]>();
  for (const link of links) {
    const group = bySale.get(link.sellReceiptId) ?? [];
    group.push(link);
    bySale.set(link.sellReceiptId, group);
  }
  for (const [saleId, group] of bySale) {
    const sale = byId.get(saleId)!,
      total = BigInt(sale.document.tokenUnitsRaw),
      proceeds =
        BigInt(sale.document.nativeSettlementRaw) -
        BigInt(sale.document.networkFeeLamports) -
        BigInt(executionCosts[sale.id] ?? '0');
    if (group.reduce((s, l) => s + BigInt(l.unitsRaw), 0n) !== total)
      throw new Error('Complete sale acquisition allocation required.');
    group.sort((a, b) => (a.buyReceiptId < b.buyReceiptId ? -1 : 1));
    let before = 0n;
    for (const link of group) {
      const units = BigInt(link.unitsRaw),
        after = before + units,
        part = (proceeds * after) / total - (proceeds * before) / total;
      before = after;
      const buy = byId.get(link.buyReceiptId)!,
        previous = totals.get(buy.id) ?? { units: 0n, proceeds: 0n, sells: 0 };
      previous.units += units;
      previous.proceeds += part;
      previous.sells++;
      if (previous.units > BigInt(buy.document.tokenUnitsRaw))
        throw new Error('Acquisition is overallocated.');
      totals.set(buy.id, previous);
    }
  }
  const lots = receipts
    .filter((r) => r.document.side === 'Buy')
    .map((buy) => {
      const assigned = totals.get(buy.id) ?? {
        units: 0n,
        proceeds: 0n,
        sells: 0,
      };
      const acquired = BigInt(buy.document.tokenUnitsRaw),
        cost =
          -BigInt(buy.document.nativeSettlementRaw) +
          BigInt(buy.document.networkFeeLamports) +
          BigInt(executionCosts[buy.id] ?? '0'),
        allocated = (cost * assigned.units) / acquired;
      return {
        buyReceiptId: buy.id,
        wallet: buy.document.wallet,
        acquiredRaw: acquired.toString(),
        assignedSoldRaw: assigned.units.toString(),
        unassignedRaw: (acquired - assigned.units).toString(),
        buyCostLamports: cost.toString(),
        assignedCostLamports: allocated.toString(),
        unassignedCostLamports: (cost - allocated).toString(),
        netAssignedProceedsLamports: assigned.proceeds.toString(),
        assignedResultLamports: (assigned.proceeds - allocated).toString(),
        sellCount: assigned.sells,
      };
    });
  const linkedSellIds = new Set(links.map((l) => l.sellReceiptId));
  const unlinkedSells = receipts.filter(
    (r) => r.document.side === 'Sell' && !linkedSellIds.has(r.id),
  );
  const sum = (
    field:
      | 'assignedCostLamports'
      | 'unassignedCostLamports'
      | 'netAssignedProceedsLamports'
      | 'assignedResultLamports',
  ) => lots.reduce((s, l) => s + BigInt(l[field]), 0n).toString();
  return {
    linkedSaleCount: bySale.size,
    unlinkedSaleCount: unlinkedSells.length,
    unlinkedSoldRaw: unlinkedSells
      .reduce((s, r) => s + BigInt(r.document.tokenUnitsRaw), 0n)
      .toString(),
    assignedCostLamports: sum('assignedCostLamports'),
    unassignedCostLamports: sum('unassignedCostLamports'),
    netAssignedProceedsLamports: sum('netAssignedProceedsLamports'),
    assignedResultLamports: sum('assignedResultLamports'),
    realizedResultLamports:
      links.length > 0 && unlinkedSells.length === 0
        ? sum('assignedResultLamports')
        : null,
    lots,
  };
}
export function proposedImportedLotLink(
  receipts: ImportedTradeReceipt[],
  links: ImportedLotLink[],
  projectId: string,
  buyReceiptId: string,
  sellReceiptId: string,
  id: string,
  createdAt: string,
) {
  if (links.some((l) => l.sellReceiptId === sellReceiptId))
    throw new Error('This sell already has a recorded acquisition link.');
  const buy = receipts.find((r) => r.id === buyReceiptId),
    sell = receipts.find((r) => r.id === sellReceiptId);
  if (!buy || !sell)
    throw new Error('Choose retained finalized buy and sell receipts.');
  const link: ImportedLotLink = {
    id,
    projectId,
    buyReceiptId,
    sellReceiptId,
    unitsRaw: sell.document.tokenUnitsRaw,
    buySignature: buy.document.signature,
    sellSignature: sell.document.signature,
    buyPreparationSha256: buy.document.preparationSha256,
    sellPreparationSha256: sell.document.preparationSha256,
    createdAt,
  };
  importedLinkedPerformance(receipts, [...links, link]);
  return link;
}
export function importedLotPage(
  value: unknown,
  projectId: string,
  mint: string,
  decimals: number,
) {
  const p = value as {
    projectId: string;
    mint: string;
    decimals: number;
    revision: number;
    receipts: ImportedTradeReceipt[];
    links: ImportedLotLink[];
    receiptDocumentHashes: Record<string, string>;
    observedAt: string;
    expenses?: BundleExpenses;
  };
  if (
    !p ||
    p.projectId !== projectId ||
    p.mint !== mint ||
    p.decimals !== decimals ||
    !Number.isSafeInteger(p.revision) ||
    p.revision < 0 ||
    p.revision > 1e9 ||
    !Array.isArray(p.receipts) ||
    !Array.isArray(p.links) ||
    !p.receiptDocumentHashes ||
    typeof p.receiptDocumentHashes !== 'object' ||
    Array.isArray(p.receiptDocumentHashes) ||
    Object.keys(p.receiptDocumentHashes).length !== p.receipts.length ||
    p.receipts.some(
      (r) =>
        typeof p.receiptDocumentHashes[r.id] !== 'string' ||
        !/^[a-f0-9]{64}$/.test(p.receiptDocumentHashes[r.id]),
    ) ||
    !Number.isFinite(Date.parse(p.observedAt))
  )
    throw new Error('Acquisition history context differs.');
  for (const r of p.receipts)
    importedTradeReceipt(r, projectId, mint, decimals);
  const expenses = validatedBundleExpenses(
    p.expenses,
    p.receipts.map((r) => r.id),
  );
  const performance = importedLinkedPerformance(
    p.receipts,
    p.links,
    expenses.executionCosts,
  );
  if (expenses.missingBundleCostCount || expenses.storageUnavailable)
    performance.realizedResultLamports = null;
  return { ...p, expenses, performance };
}
export type ImportedLotPage = ReturnType<typeof importedLotPage>;
export function importedLotAssignmentPreview(
  page: ImportedLotPage,
  buyId: string,
  sellId: string,
) {
  const link = proposedImportedLotLink(
    page.receipts,
    page.links,
    page.projectId,
    buyId,
    sellId,
    crypto.randomUUID(),
    new Date().toISOString(),
  );
  const after = importedLinkedPerformance(
    page.receipts,
    [...page.links, link],
    page.expenses.executionCosts,
  );
  return {
    link,
    missingBundleCostCount: page.expenses.missingBundleCostCount,
    storageUnavailable: page.expenses.storageUnavailable ?? false,
    cost: (
      BigInt(after.assignedCostLamports) -
      BigInt(page.performance.assignedCostLamports)
    ).toString(),
    proceeds: (
      BigInt(after.netAssignedProceedsLamports) -
      BigInt(page.performance.netAssignedProceedsLamports)
    ).toString(),
    result: (
      BigInt(after.assignedResultLamports) -
      BigInt(page.performance.assignedResultLamports)
    ).toString(),
  };
}
