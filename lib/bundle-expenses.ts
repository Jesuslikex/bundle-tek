export type BundleExpenses = {
  executionCosts: Record<string, string>;
  bundleTipLamports: string;
  bundleFeeLamports: string;
  missingBundleCostCount: number;
  storageUnavailable?: boolean;
};
export const emptyBundleExpenses = (): BundleExpenses => ({
  executionCosts: {},
  bundleTipLamports: '0',
  bundleFeeLamports: '0',
  missingBundleCostCount: 0,
});
export function validatedBundleExpenses(
  value: BundleExpenses | undefined,
  receiptIds: string[],
) {
  if (value === undefined) return emptyBundleExpenses();
  const ceiling = 8000n * ((1n << 64n) - 1n);
  const money = (v: unknown): v is string =>
    typeof v === 'string' &&
    /^(0|[1-9]\d{0,23})$/.test(v) &&
    BigInt(v) <= ceiling;
  if (
    !value ||
    !value.executionCosts ||
    typeof value.executionCosts !== 'object' ||
    Array.isArray(value.executionCosts) ||
    !money(value.bundleTipLamports) ||
    !money(value.bundleFeeLamports) ||
    !Number.isSafeInteger(value.missingBundleCostCount) ||
    value.missingBundleCostCount < 0 ||
    value.missingBundleCostCount > 4000 ||
    (value.storageUnavailable !== undefined &&
      typeof value.storageUnavailable !== 'boolean')
  )
    throw new Error('Bundle expense coverage differs.');
  if (
    value.storageUnavailable &&
    (value.bundleTipLamports !== '0' ||
      value.bundleFeeLamports !== '0' ||
      Object.keys(value.executionCosts).length ||
      value.missingBundleCostCount !== 0)
  )
    throw new Error(
      'Unavailable bundle storage cannot establish expenses or counts.',
    );
  const ids = new Set(receiptIds);
  let total = 0n;
  for (const [id, cost] of Object.entries(value.executionCosts)) {
    if (!ids.has(id) || !money(cost))
      throw new Error('Bundle expense receipt differs.');
    total += BigInt(cost);
  }
  if (
    total !==
    BigInt(value.bundleTipLamports) + BigInt(value.bundleFeeLamports)
  )
    throw new Error('Bundle expense allocation differs.');
  return value;
}
