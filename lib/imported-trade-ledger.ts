import bs58 from 'bs58';
import {
  validatedBundleExpenses,
  type BundleExpenses,
} from './bundle-expenses';
import {
  validatedImportedPerformance,
  type ImportedPerformance,
} from './imported-performance-format';
import type { ImportedSwapReceipt } from './imported-approval-history';
import { UUID } from './wallet-operation';
import {
  formatNativeBalance,
  signedBalanceAmount,
} from './wallet-balance-format';

export const IMPORTED_LEDGER_LIMIT = 4000;
export type ImportedTradeReceipt = ImportedSwapReceipt & {
  document: ImportedSwapReceipt['document'] & {
    slot: number;
    blockTime: number | null;
    networkFeeLamports: string;
    nativeChangeRaw: string;
    rentChangeRaw: string;
    nativeSettlementRaw: string;
  };
};
const uint64 = (value: unknown, positive = false) =>
  typeof value === 'string' &&
  /^(0|[1-9]\d{0,19})$/.test(value) &&
  BigInt(value) <= (1n << 64n) - 1n &&
  (!positive || BigInt(value) > 0n);
const signed64 = (value: unknown) =>
  typeof value === 'string' &&
  /^(0|-?[1-9]\d{0,19})$/.test(value) &&
  BigInt(value) >= -((1n << 64n) - 1n) &&
  BigInt(value) <= (1n << 64n) - 1n;
export function importedTradeReceipt(
  value: unknown,
  projectId: string,
  mint: string,
  decimals: number,
): ImportedTradeReceipt {
  const row = value as ImportedTradeReceipt,
    doc = row?.document;
  if (
    !row ||
    !doc ||
    !UUID.test(row.id) ||
    !UUID.test(row.preparationId) ||
    row.projectId !== projectId ||
    !Number.isSafeInteger(row.projectRevision) ||
    row.projectRevision < 1 ||
    !Number.isSafeInteger(row.walletRevision) ||
    row.walletRevision < 1 ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    !Number.isFinite(Date.parse(doc.observedAt)) ||
    doc.network !== 'mainnet' ||
    doc.commitment !== 'finalized' ||
    doc.signatureVerified !== true ||
    doc.mint !== mint ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    doc.decimals !== decimals ||
    !['Buy', 'Sell'].includes(doc.side) ||
    !/^[a-f0-9]{64}$/.test(doc.preparationSha256) ||
    !Number.isSafeInteger(doc.slot) ||
    doc.slot < 0 ||
    (doc.blockTime !== null &&
      (!Number.isSafeInteger(doc.blockTime) || doc.blockTime < 0)) ||
    !uint64(doc.tokenUnitsRaw, true) ||
    !uint64(doc.networkFeeLamports) ||
    !signed64(doc.nativeChangeRaw) ||
    !signed64(doc.rentChangeRaw) ||
    !signed64(doc.nativeSettlementRaw) ||
    (doc.side === 'Buy'
      ? BigInt(doc.nativeSettlementRaw) >= 0n
      : BigInt(doc.nativeSettlementRaw) <= 0n) ||
    typeof doc.source !== 'string' ||
    doc.source.length > 253 ||
    !/^[a-zA-Z0-9.-]+$/.test(doc.source)
  )
    throw new Error('Retained trade evidence differs.');
  try {
    if (
      typeof doc.signature !== 'string' ||
      doc.signature.length > 90 ||
      bs58.decode(doc.signature).length !== 64 ||
      typeof doc.wallet !== 'string' ||
      doc.wallet.length > 44 ||
      bs58.decode(doc.wallet).length !== 32 ||
      bs58.decode(doc.mint).length !== 32
    )
      throw new Error();
  } catch {
    throw new Error('Retained trade identity differs.');
  }
  return row;
}
export function summarizeImportedTrades(rows: ImportedTradeReceipt[]) {
  if (
    rows.length > IMPORTED_LEDGER_LIMIT ||
    new Set(rows.map((row) => row.document.signature)).size !== rows.length ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  )
    throw new Error('Complete unique trade history required.');
  const totals = {
    buyCount: 0,
    sellCount: 0,
    boughtRaw: 0n,
    soldRaw: 0n,
    solSpentRaw: 0n,
    solReceivedRaw: 0n,
    networkFeeLamports: 0n,
    nativeChangeRaw: 0n,
    rentChangeRaw: 0n,
  };
  for (const { document: doc } of rows) {
    if (doc.side === 'Buy') {
      totals.buyCount++;
      totals.boughtRaw += BigInt(doc.tokenUnitsRaw);
      totals.solSpentRaw -= BigInt(doc.nativeSettlementRaw);
    } else {
      totals.sellCount++;
      totals.soldRaw += BigInt(doc.tokenUnitsRaw);
      totals.solReceivedRaw += BigInt(doc.nativeSettlementRaw);
    }
    totals.networkFeeLamports += BigInt(doc.networkFeeLamports);
    totals.nativeChangeRaw += BigInt(doc.nativeChangeRaw);
    totals.rentChangeRaw += BigInt(doc.rentChangeRaw);
  }
  return {
    receiptCount: rows.length,
    buyCount: totals.buyCount,
    sellCount: totals.sellCount,
    boughtRaw: totals.boughtRaw.toString(),
    soldRaw: totals.soldRaw.toString(),
    netTokenChangeRaw: (totals.boughtRaw - totals.soldRaw).toString(),
    solSpentRaw: totals.solSpentRaw.toString(),
    solReceivedRaw: totals.solReceivedRaw.toString(),
    networkFeeLamports: totals.networkFeeLamports.toString(),
    nativeChangeRaw: totals.nativeChangeRaw.toString(),
    rentChangeRaw: totals.rentChangeRaw.toString(),
  };
}
export type ImportedTradeSummary = ReturnType<typeof summarizeImportedTrades>;
export type ImportedTradePage = {
  projectId: string;
  mint: string;
  decimals: number;
  receipts: ImportedTradeReceipt[];
  nextCursor: string | null;
  summary: ImportedTradeSummary;
  performance: ImportedPerformance;
  observedAt: string;
};
export function importedTradePage(
  value: unknown,
  projectId: string,
  mint: string,
  decimals: number,
) {
  const page = value as ImportedTradePage;
  if (
    !page ||
    page.projectId !== projectId ||
    page.mint !== mint ||
    page.decimals !== decimals ||
    !Array.isArray(page.receipts) ||
    page.receipts.length > 50 ||
    (page.nextCursor !== null &&
      (typeof page.nextCursor !== 'string' || !UUID.test(page.nextCursor))) ||
    !Number.isFinite(Date.parse(page.observedAt)) ||
    !page.summary ||
    !Number.isSafeInteger(page.summary.receiptCount) ||
    page.summary.receiptCount < page.receipts.length ||
    page.summary.receiptCount > IMPORTED_LEDGER_LIMIT ||
    !Number.isSafeInteger(page.summary.buyCount) ||
    page.summary.buyCount < 0 ||
    !Number.isSafeInteger(page.summary.sellCount) ||
    page.summary.sellCount < 0 ||
    page.summary.buyCount + page.summary.sellCount !==
      page.summary.receiptCount ||
    ![
      'boughtRaw',
      'soldRaw',
      'solSpentRaw',
      'solReceivedRaw',
      'networkFeeLamports',
    ].every(
      (key) =>
        typeof page.summary[key as keyof ImportedTradeSummary] === 'string' &&
        /^(0|[1-9]\d{0,23})$/.test(
          String(page.summary[key as keyof ImportedTradeSummary]),
        ),
    ) ||
    !['netTokenChangeRaw', 'nativeChangeRaw', 'rentChangeRaw'].every(
      (key) =>
        typeof page.summary[key as keyof ImportedTradeSummary] === 'string' &&
        /^(0|-?[1-9]\d{0,23})$/.test(
          String(page.summary[key as keyof ImportedTradeSummary]),
        ),
    ) ||
    BigInt(page.summary.boughtRaw) - BigInt(page.summary.soldRaw) !==
      BigInt(page.summary.netTokenChangeRaw)
  )
    throw new Error('Trade ledger context differs.');
  validatedImportedPerformance(
    page.performance,
    page.summary.receiptCount,
    page.summary.boughtRaw,
    page.summary.soldRaw,
  );
  if (
    page.performance.buyCount !== page.summary.buyCount ||
    page.performance.sellCount !== page.summary.sellCount
  )
    throw new Error('Recorded performance counts differ.');
  page.receipts.forEach((row) =>
    importedTradeReceipt(row, projectId, mint, decimals),
  );
  if (
    new Set(page.receipts.map((row) => row.id)).size !== page.receipts.length ||
    new Set(page.receipts.map((row) => row.document.signature)).size !==
      page.receipts.length
  )
    throw new Error('Duplicate trade evidence.');
  return page;
}
export function importedTradeCsv(
  rows: ImportedTradeReceipt[],
  expenseEvidence?: BundleExpenses,
) {
  summarizeImportedTrades(rows);
  const expenses = validatedBundleExpenses(
    expenseEvidence,
    rows.map((r) => r.id),
  );
  const columns = [
    'receipt_id',
    'project_id',
    'project_revision',
    'preparation_id',
    'wallet_revision',
    'wallet',
    'side',
    'mint',
    'decimals',
    'token_units_raw',
    'token_amount',
    'sol_settlement_lamports',
    'sol_settlement',
    'network_fee_lamports',
    'wallet_sol_change_lamports',
    'rent_change_lamports',
    'slot',
    'block_time',
    'signature',
    'recorded_at',
    'observed_at',
    'source',
  ];
  if (expenseEvidence)
    columns.push('allocated_bundle_cost_lamports', 'bundle_cost_coverage');
  const escape = (value: string | number | null | undefined) =>
    '"' + String(value ?? '').replaceAll('"', '""') + '"';
  return (
    [
      columns.map(escape).join(','),
      ...rows.map((row) => {
        const d = row.document;
        return [
          row.id,
          row.projectId,
          row.projectRevision,
          row.preparationId,
          row.walletRevision,
          d.wallet,
          d.side,
          d.mint,
          d.decimals,
          d.tokenUnitsRaw,
          formatNativeBalance(d.tokenUnitsRaw, d.decimals),
          d.nativeSettlementRaw,
          signedBalanceAmount(d.nativeSettlementRaw, 9),
          d.networkFeeLamports,
          d.nativeChangeRaw,
          d.rentChangeRaw,
          d.slot,
          d.blockTime,
          d.signature,
          row.createdAt,
          d.observedAt,
          d.source,
          ...(expenseEvidence
            ? [
                expenses.executionCosts[row.id] ??
                  (expenses.missingBundleCostCount ||
                  expenses.storageUnavailable
                    ? ''
                    : '0'),
                expenses.storageUnavailable
                  ? 'storage-unavailable'
                  : expenses.missingBundleCostCount
                    ? 'incomplete'
                    : 'complete',
              ]
            : []),
        ]
          .map(escape)
          .join(',');
      }),
    ].join('\r\n') + '\r\n'
  );
}
