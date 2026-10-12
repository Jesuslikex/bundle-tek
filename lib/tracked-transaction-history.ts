export type TrackedTransactionSummary = {
  signature: string;
  slot: number;
  failed: boolean;
  feeRaw: string;
  nativeChangeRaw: string | null;
  tokenChangeCount: number;
  tokensComplete: boolean;
  observedAt: string;
  capturedUpdatedAt: string;
  stale: boolean;
};
export function trackerTimestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error('Invalid tracked wallet timestamp.');
  return value;
}
