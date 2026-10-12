import { importedLinkedPerformance } from './imported-lot-links';
import {
  summarizeImportedTrades,
  type ImportedTradeReceipt,
} from './imported-trade-ledger';
import { warmupLotPerformance } from './warmup-lot-performance';
import type {
  PerformanceTimelineData,
  RealizedSale,
} from './performance-timeline';
import {
  ACCOUNT_PERFORMANCE_LIMIT,
  accountPerformanceFromScopes,
  type AccountPerformance,
  type PerformanceScope,
  type ImportedPerformanceSource,
  type WarmupPerformanceSource,
} from './account-performance';

export function summarizeAccountPerformance(
  imports: ImportedPerformanceSource[],
  warmups: WarmupPerformanceSource[],
  observedAt: string,
): AccountPerformance {
  const signatures = [
    ...imports.flatMap((s) => s.receipts.map((r) => r.document.signature)),
    ...warmups.flatMap((s) =>
      [...s.buys, ...s.sells].map((r) => r.document.signature),
    ),
  ];
  if (
    signatures.length > ACCOUNT_PERFORMANCE_LIMIT ||
    new Set(signatures).size !== signatures.length
  )
    throw new Error('Complete unique account trade evidence required.');
  const scopes: PerformanceScope[] = [
    ...imports.map((source) => {
      const p = importedLinkedPerformance(source.receipts, source.links),
        ledger = summarizeImportedTrades(source.receipts);
      return {
        kind: 'Imported trades' as const,
        id: source.id,
        name: source.name,
        archived: source.archived,
        buyCount: ledger.buyCount,
        sellCount: ledger.sellCount,
        linkedSaleCount: p.linkedSaleCount,
        unlinkedSaleCount: p.unlinkedSaleCount,
        allocatedCostLamports: p.assignedCostLamports,
        unallocatedCostLamports: p.unassignedCostLamports,
        linkedNetProceedsLamports: p.netAssignedProceedsLamports,
        linkedResultLamports: p.assignedResultLamports,
        successfulFeeLamports: ledger.networkFeeLamports,
        rentChangeLamports: ledger.rentChangeRaw,
      };
    }),
    ...warmups.map((source) => {
      const p = warmupLotPerformance(
        source.buys,
        source.sells,
        source.buys.map((b) => b.id),
      );
      return {
        kind: 'Warmup' as const,
        id: source.id,
        name: source.name,
        archived: source.archived,
        buyCount: source.buys.length,
        sellCount: source.sells.length,
        linkedSaleCount: source.sells.length,
        unlinkedSaleCount: 0,
        allocatedCostLamports: p.realizedCostLamports,
        unallocatedCostLamports: p.openCostLamports,
        linkedNetProceedsLamports: p.netSellProceedsLamports,
        linkedResultLamports: p.realizedResultLamports,
        successfulFeeLamports: p.networkFeeLamports,
        rentChangeLamports: p.rentChangeLamports,
      };
    }),
  ].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  // Never accept a caller's label/context for receipts belonging to another scope.
  if (imports.some((s) => s.receipts.some((r) => r.projectId !== s.id)))
    throw new Error('Account project context differs.');
  return accountPerformanceFromScopes(scopes, observedAt);
}

const blockTime = (document: unknown) => {
  const value = (document as { blockTime?: unknown }).blockTime;
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
};
/**
 * Splits each lot's allocated cost across its sales in finalized-slot order.
 * The increments telescope to the lot totals, so per-sale results sum exactly to
 * the linked results reported by summarizeAccountPerformance.
 */
function allocateLotCost(
  cost: bigint,
  acquired: bigint,
  parts: Array<{ saleId: string; slot: number; units: bigint }>,
) {
  const shares = new Map<string, bigint>();
  let sold = 0n;
  for (const part of [...parts].sort(
    (a, b) => a.slot - b.slot || (a.saleId < b.saleId ? -1 : 1),
  )) {
    const before = (cost * sold) / acquired;
    sold += part.units;
    shares.set(
      part.saleId,
      (shares.get(part.saleId) ?? 0n) + (cost * sold) / acquired - before,
    );
  }
  return shares;
}
function importedSales(source: ImportedPerformanceSource): RealizedSale[] {
  const byId = new Map(source.receipts.map((r) => [r.id, r]));
  const costs = new Map<string, bigint>(),
    proceeds = new Map<string, bigint>();
  const linksBySale = new Map<string, typeof source.links>();
  for (const link of source.links) {
    const group = linksBySale.get(link.sellReceiptId) ?? [];
    group.push(link);
    linksBySale.set(link.sellReceiptId, group);
  }
  // Proceeds split matches importedLinkedPerformance: by units, ordered by buy receipt id.
  const partsByBuy = new Map<
    string,
    Array<{ saleId: string; slot: number; units: bigint }>
  >();
  for (const [saleId, group] of linksBySale) {
    const sale = byId.get(saleId)!;
    proceeds.set(
      saleId,
      BigInt(sale.document.nativeSettlementRaw) -
        BigInt(sale.document.networkFeeLamports),
    );
    for (const link of group) {
      const parts = partsByBuy.get(link.buyReceiptId) ?? [];
      parts.push({
        saleId,
        slot: sale.document.slot,
        units: BigInt(link.unitsRaw),
      });
      partsByBuy.set(link.buyReceiptId, parts);
    }
  }
  for (const [buyId, parts] of partsByBuy) {
    const buy = byId.get(buyId)!;
    const cost =
      -BigInt(buy.document.nativeSettlementRaw) +
      BigInt(buy.document.networkFeeLamports);
    for (const [saleId, share] of allocateLotCost(
      cost,
      BigInt(buy.document.tokenUnitsRaw),
      parts,
    ))
      costs.set(saleId, (costs.get(saleId) ?? 0n) + share);
  }
  return [...linksBySale.keys()].map((saleId) => {
    const sale: ImportedTradeReceipt = byId.get(saleId)!;
    const cost = costs.get(saleId) ?? 0n,
      net = proceeds.get(saleId)!;
    return {
      kind: 'Imported trades',
      scopeId: source.id,
      scopeName: source.name,
      saleId,
      signature: sale.document.signature,
      wallet: sale.document.wallet,
      slot: sale.document.slot,
      blockTime: blockTime(sale.document),
      costLamports: cost.toString(),
      netProceedsLamports: net.toString(),
      resultLamports: (net - cost).toString(),
    };
  });
}
function warmupSales(source: WarmupPerformanceSource): RealizedSale[] {
  const buys = new Map(source.buys.map((b) => [b.id, b]));
  const partsByBuy = new Map<
    string,
    Array<{ saleId: string; slot: number; units: bigint }>
  >();
  for (const sell of source.sells) {
    const parts = partsByBuy.get(sell.buyId) ?? [];
    parts.push({
      saleId: sell.id,
      slot: sell.document.slot,
      units: BigInt(sell.consumedRaw),
    });
    partsByBuy.set(sell.buyId, parts);
  }
  const costs = new Map<string, bigint>();
  for (const [buyId, parts] of partsByBuy) {
    const buy = buys.get(buyId)!;
    const cost =
      -BigInt(buy.document.nativeSettlementRaw) +
      BigInt(buy.document.networkFeeLamports);
    for (const [saleId, share] of allocateLotCost(
      cost,
      BigInt(buy.acquiredRaw),
      parts,
    ))
      costs.set(saleId, share);
  }
  return source.sells.map((sell) => {
    const net =
        BigInt(sell.document.nativeSettlementRaw) -
        BigInt(sell.document.networkFeeLamports),
      cost = costs.get(sell.id)!;
    return {
      kind: 'Warmup',
      scopeId: source.id,
      scopeName: source.name,
      saleId: sell.id,
      signature: sell.document.signature,
      wallet: sell.document.wallet,
      slot: sell.document.slot,
      blockTime: blockTime(sell.document),
      costLamports: cost.toString(),
      netProceedsLamports: net.toString(),
      resultLamports: (net - cost).toString(),
    };
  });
}

/** Summary plus per-sale timeline evidence from one validated snapshot. */
export function summarizeAccountTimeline(
  imports: ImportedPerformanceSource[],
  warmups: WarmupPerformanceSource[],
  observedAt: string,
): { summary: AccountPerformance; timeline: PerformanceTimelineData } {
  // Runs every receipt, link and lot validation before any per-sale split.
  const summary = summarizeAccountPerformance(imports, warmups, observedAt);
  const sales = [
    ...imports.flatMap(importedSales),
    ...warmups.flatMap(warmupSales),
  ];
  const total = sales.reduce((n, s) => n + BigInt(s.resultLamports), 0n);
  if (
    sales.length !== summary.linkedSaleCount ||
    total.toString() !== summary.linkedResultLamports
  )
    throw new Error('Per-sale results do not reconcile with linked totals.');
  return {
    summary,
    timeline: {
      observedAt,
      sales,
      unlinkedSaleCount: summary.unlinkedSaleCount,
    },
  };
}
