import {
  importedTradeReceipt,
  summarizeImportedTrades,
  type ImportedTradeReceipt,
} from './imported-trade-ledger';
import {
  validatedImportedPerformance,
  type ImportedPerformance,
  type ImportedWalletPerformance,
} from './imported-performance-format';
import {
  validatedBundleExpenses,
  type BundleExpenses,
} from './bundle-expenses';

/** Accounting model for saved swaps only; never establishes actual wallet inventory or external cost basis. */
export function importedTradePerformance(
  rows: ImportedTradeReceipt[],
  expenseEvidence?: BundleExpenses,
): ImportedPerformance {
  const summary = summarizeImportedTrades(rows);
  const expenses = validatedBundleExpenses(
    expenseEvidence,
    rows.map((r) => r.id),
  );
  const groups = new Map<string, ImportedTradeReceipt[]>();
  const first = rows[0];
  for (const row of rows) {
    importedTradeReceipt(
      row,
      first.projectId,
      first.document.mint,
      first.document.decimals,
    );
    const group = groups.get(row.document.wallet) ?? [];
    group.push(row);
    groups.set(row.document.wallet, group);
  }
  const wallets: ImportedWalletPerformance[] = [];
  for (const [wallet, group] of groups) {
    const buys = group.filter((r) => r.document.side === 'Buy'),
      sells = group.filter((r) => r.document.side === 'Sell');
    const ordered =
      new Set(group.map((r) => r.document.slot)).size === group.length;
    const record: ImportedWalletPerformance = {
      wallet,
      receiptCount: group.length,
      buyCount: buys.length,
      sellCount: sells.length,
      ordering: ordered ? 'by-finalized-slot' : 'unavailable',
      matchedSoldRaw: '0',
      unknownBasisSoldRaw: '0',
      unresolvedSoldRaw: '0',
      realizedCostLamports: '0',
      attributedNetProceedsLamports: '0',
      attributedResultLamports: '0',
      realizedResultLamports: null,
      openCostLamports: ordered ? '0' : null,
      recordedOpenRaw: ordered ? '0' : null,
    };
    if (!ordered) {
      record.unresolvedSoldRaw = sells
        .reduce((n, r) => n + BigInt(r.document.tokenUnitsRaw), 0n)
        .toString();
      wallets.push(record);
      continue;
    }
    const lots: Array<{ units: bigint; sold: bigint; cost: bigint }> = [];
    let head = 0,
      matched = 0n,
      unknown = 0n,
      cost = 0n,
      proceeds = 0n;
    for (const { id, document: d } of [...group].sort(
      (a, b) => a.document.slot - b.document.slot,
    )) {
      const units = BigInt(d.tokenUnitsRaw),
        fee =
          BigInt(d.networkFeeLamports) +
          BigInt(expenses.executionCosts[id] ?? '0'),
        settlement = BigInt(d.nativeSettlementRaw);
      if (d.side === 'Buy') {
        lots.push({ units, sold: 0n, cost: -settlement + fee });
        continue;
      }
      let remaining = units;
      while (remaining > 0n && head < lots.length) {
        const lot = lots[head],
          available = lot.units - lot.sold,
          consumed = available < remaining ? available : remaining;
        const before = (lot.cost * lot.sold) / lot.units;
        lot.sold += consumed;
        cost += (lot.cost * lot.sold) / lot.units - before;
        remaining -= consumed;
        if (lot.sold === lot.units) head++;
      }
      const attributed = units - remaining;
      matched += attributed;
      unknown += remaining;
      // Unknown-basis proceeds keep the residual. Negative net proceeds remain a cost, never a gain.
      proceeds += ((settlement - fee) * attributed) / units;
    }
    record.matchedSoldRaw = matched.toString();
    record.unknownBasisSoldRaw = unknown.toString();
    record.realizedCostLamports = cost.toString();
    record.attributedNetProceedsLamports = proceeds.toString();
    record.attributedResultLamports = (proceeds - cost).toString();
    record.realizedResultLamports =
      sells.length > 0 &&
      unknown === 0n &&
      expenses.missingBundleCostCount === 0 &&
      !expenses.storageUnavailable
        ? record.attributedResultLamports
        : null;
    record.openCostLamports = lots
      .reduce((n, l) => n + l.cost - (l.cost * l.sold) / l.units, 0n)
      .toString();
    record.recordedOpenRaw = lots
      .reduce((n, l) => n + l.units - l.sold, 0n)
      .toString();
    wallets.push(record);
  }
  wallets.sort((a, b) => a.wallet.localeCompare(b.wallet));
  const sum = (
    key:
      | 'matchedSoldRaw'
      | 'unknownBasisSoldRaw'
      | 'unresolvedSoldRaw'
      | 'realizedCostLamports'
      | 'attributedNetProceedsLamports'
      | 'attributedResultLamports',
  ) => wallets.reduce((n, w) => n + BigInt(w[key]), 0n).toString();
  const nullableSum = (key: 'openCostLamports' | 'recordedOpenRaw') =>
    wallets.some((w) => w[key] === null)
      ? null
      : wallets.reduce((n, w) => n + BigInt(w[key]!), 0n).toString();
  const p: ImportedPerformance = {
    method: 'recorded-fifo',
    bundleTipLamports: expenses.bundleTipLamports,
    bundleFeeLamports: expenses.bundleFeeLamports,
    missingBundleCostCount: expenses.missingBundleCostCount,
    bundleCostStorageUnavailable: expenses.storageUnavailable ?? false,
    receiptCount: rows.length,
    buyCount: summary.buyCount,
    sellCount: summary.sellCount,
    wallets,
    matchedSoldRaw: sum('matchedSoldRaw'),
    unknownBasisSoldRaw: sum('unknownBasisSoldRaw'),
    unresolvedSoldRaw: sum('unresolvedSoldRaw'),
    realizedCostLamports: sum('realizedCostLamports'),
    attributedNetProceedsLamports: sum('attributedNetProceedsLamports'),
    attributedResultLamports: sum('attributedResultLamports'),
    realizedResultLamports:
      summary.sellCount > 0 &&
      expenses.missingBundleCostCount === 0 &&
      !expenses.storageUnavailable &&
      wallets.every(
        (w) =>
          w.ordering === 'by-finalized-slot' && w.unknownBasisSoldRaw === '0',
      )
        ? sum('attributedResultLamports')
        : null,
    openCostLamports: nullableSum('openCostLamports'),
    recordedOpenRaw: nullableSum('recordedOpenRaw'),
  };
  return validatedImportedPerformance(
    p,
    summary.receiptCount,
    summary.boughtRaw,
    summary.soldRaw,
  );
}
