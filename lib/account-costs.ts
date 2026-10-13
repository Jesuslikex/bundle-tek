export const ACCOUNT_COST_LIMIT = 4000;
export const ACCOUNT_COST_CATEGORIES = [
  'Imported swaps',
  'Warmup swaps',
  'Withdrawals',
  'Jito tips',
] as const;
export type AccountCostCategory = (typeof ACCOUNT_COST_CATEGORIES)[number];
export type AccountCostEntry = {
  category: AccountCostCategory;
  signature: string;
  outcome: 'success' | 'failed';
  feeLamports: string;
  tipLamports?: string;
};
export type AccountCostCoverage = {
  pendingCount: number;
  missingFailureCount: number;
  missingFinalizedCount: number;
  missingBundleCostCount?: number;
  storageUnavailable?: boolean;
};
export type AccountCosts = ReturnType<typeof summarizeAccountCosts>;
const uint = (s: unknown): s is string =>
  typeof s === 'string' &&
  /^(0|[1-9]\d{0,19})$/.test(s) &&
  BigInt(s) <= (1n << 64n) - 1n;
const count = (n: unknown): n is number =>
  Number.isSafeInteger(n) &&
  (n as number) >= 0 &&
  (n as number) <= ACCOUNT_COST_LIMIT;
const total = (s: unknown): s is string =>
  typeof s === 'string' &&
  /^(0|[1-9]\d{0,23})$/.test(s) &&
  BigInt(s) <= BigInt(ACCOUNT_COST_LIMIT) * ((1n << 64n) - 1n);

/** Network fees and retained bundle tips. Other transfers, rent and swap consideration are not losses. */
export function summarizeAccountCosts(
  entries: AccountCostEntry[],
  coverage: AccountCostCoverage,
  observedAt: string,
) {
  if (
    entries.length > ACCOUNT_COST_LIMIT ||
    new Set(entries.map((e) => e.signature)).size !== entries.length ||
    ![
      coverage.pendingCount,
      coverage.missingFailureCount,
      coverage.missingFinalizedCount,
      coverage.missingBundleCostCount ?? 0,
    ].every(count) ||
    (coverage.storageUnavailable !== undefined &&
      typeof coverage.storageUnavailable !== 'boolean') ||
    !Number.isFinite(Date.parse(observedAt))
  )
    throw new Error('Complete unique cost evidence required.');
  if (
    entries.some(
      (e) =>
        !uint(e.tipLamports ?? '0') ||
        (e.category === 'Jito tips' && e.outcome === 'success'
          ? BigInt(e.tipLamports ?? '0') === 0n
          : (e.tipLamports ?? '0') !== '0'),
    )
  )
    throw new Error('Invalid retained bundle tip expense.');
  const categories = ACCOUNT_COST_CATEGORIES.map((category) => {
    const rows = entries.filter((e) => e.category === category);
    const sum = (outcome: AccountCostEntry['outcome']) =>
      rows
        .filter((e) => e.outcome === outcome)
        .reduce((total, e) => {
          if (!uint(e.feeLamports)) throw new Error('Invalid recorded fee.');
          return total + BigInt(e.feeLamports);
        }, 0n)
        .toString();
    return {
      category,
      successCount: rows.filter((e) => e.outcome === 'success').length,
      failedCount: rows.filter((e) => e.outcome === 'failed').length,
      successfulFeeLamports: sum('success'),
      failedFeeLamports: sum('failed'),
      bundleTipLamports: rows
        .reduce((n, e) => n + BigInt(e.tipLamports ?? '0'), 0n)
        .toString(),
    };
  });
  if (
    entries.some(
      (e) =>
        !ACCOUNT_COST_CATEGORIES.includes(e.category) ||
        !['success', 'failed'].includes(e.outcome) ||
        !e.signature,
    )
  )
    throw new Error('Invalid cost evidence.');
  const successfulFeeLamports = categories
    .reduce((s, row) => s + BigInt(row.successfulFeeLamports), 0n)
    .toString();
  const failedFeeLamports = categories
    .reduce((s, row) => s + BigInt(row.failedFeeLamports), 0n)
    .toString();
  const bundleTipLamports = categories
    .reduce((n, r) => n + BigInt(r.bundleTipLamports), 0n)
    .toString();
  return {
    categories,
    receiptCount: entries.length,
    successfulFeeLamports,
    failedFeeLamports,
    bundleTipLamports,
    totalRecordedCostLamports: (
      BigInt(successfulFeeLamports) +
      BigInt(failedFeeLamports) +
      BigInt(bundleTipLamports)
    ).toString(),
    totalFeeLamports: (
      BigInt(successfulFeeLamports) + BigInt(failedFeeLamports)
    ).toString(),
    pendingCount: coverage.pendingCount,
    missingFailureCount: coverage.missingFailureCount,
    missingFinalizedCount: coverage.missingFinalizedCount,
    bundleCostStorageUnavailable: coverage.storageUnavailable ?? false,
    missingBundleCostCount: coverage.missingBundleCostCount ?? 0,
    observedAt,
  };
}

export function validatedAccountCosts(value: unknown): AccountCosts {
  const v = value as AccountCosts;
  if (
    !v ||
    !Array.isArray(v.categories) ||
    v.categories.length !== ACCOUNT_COST_CATEGORIES.length ||
    ![
      v.receiptCount,
      v.pendingCount,
      v.missingFailureCount,
      v.missingFinalizedCount,
      v.missingBundleCostCount,
    ].every(count) ||
    !Number.isFinite(Date.parse(v.observedAt))
  )
    throw new Error('Cost summary unavailable.');
  if (typeof v.bundleCostStorageUnavailable !== 'boolean')
    throw new Error('Bundle storage coverage differs.');
  let successes = 0n,
    failures = 0n,
    tips = 0n,
    receipts = 0;
  for (const [index, row] of v.categories.entries()) {
    if (
      row.category !== ACCOUNT_COST_CATEGORIES[index] ||
      ![row.successCount, row.failedCount].every(count) ||
      !total(row.successfulFeeLamports) ||
      !total(row.failedFeeLamports) ||
      !total(row.bundleTipLamports) ||
      (row.category !== 'Jito tips' && row.bundleTipLamports !== '0') ||
      (row.successCount === 0 && row.bundleTipLamports !== '0') ||
      (row.category === 'Jito tips' &&
        row.successCount > 0 &&
        row.bundleTipLamports === '0') ||
      (row.successCount === 0 && row.successfulFeeLamports !== '0') ||
      (row.failedCount === 0 && row.failedFeeLamports !== '0')
    )
      throw new Error('Cost coverage differs.');
    successes += BigInt(row.successfulFeeLamports);
    failures += BigInt(row.failedFeeLamports);
    tips += BigInt(row.bundleTipLamports);
    receipts += row.successCount + row.failedCount;
  }
  if (
    v.successfulFeeLamports !== successes.toString() ||
    v.failedFeeLamports !== failures.toString() ||
    v.totalFeeLamports !== (successes + failures).toString() ||
    v.bundleTipLamports !== tips.toString() ||
    v.totalRecordedCostLamports !== (successes + failures + tips).toString() ||
    v.receiptCount !== receipts
  )
    throw new Error('Cost totals differ.');
  return v;
}
