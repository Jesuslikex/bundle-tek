import { importedLinkedPerformance } from './imported-lot-links';
import { summarizeImportedTrades } from './imported-trade-ledger';
import { warmupLotPerformance } from './warmup-lot-performance';
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
