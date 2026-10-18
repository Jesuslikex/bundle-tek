import type { PumpPurchaseCostSource } from './pump-purchase-costs';
import type { ImportedSaleEvidence } from './imported-sale-evidence';
import { pumpHolderDigest } from './pump-holder-review';
/** Expected review/refusal outcome, safe to show to the owner. */
export class LaunchSaleAllocationError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
export const LAUNCH_SALE_POLICY = 'recorded-launch-units-v1' as const;
export type LaunchSaleInput = {
  source: PumpPurchaseCostSource;
  receiptSha256: string;
  buySlot: string;
  beforeRaw: string;
  unitsRaw: string;
};
const uint = (v: unknown, positive = false) => {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(v) ||
    BigInt(v) > 18446744073709551615n ||
    (positive && BigInt(v) === 0n)
  )
    throw new LaunchSaleAllocationError('Recorded acquisition units differ.');
  return BigInt(v);
};
/** Bookkeeping only: original server readers must replay sale and buy evidence.
 * Quote principal and SOL expenses remain separate; no basis/profit authority. */
export async function planLaunchSaleAllocation(
  sale: ImportedSaleEvidence,
  supplied: LaunchSaleInput[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const e = structuredClone(sale),
    inputs = structuredClone(supplied);
  if (
    inputs.length < 1 ||
    inputs.length > 8 ||
    new Set(inputs.map((i) => i.source.originId)).size !== inputs.length ||
    e.executionAllowed !== false ||
    e.signingAllowed !== false ||
    e.profitCalculated !== false ||
    e.report.decimals !== 6
  )
    throw new LaunchSaleAllocationError(
      'Select one to eight distinct recorded launch buys for a six-decimal sale.',
    );
  inputs.sort((a, b) => a.source.originId.localeCompare(b.source.originId));
  const allocations = inputs.map(
    ({ source: s, receiptSha256, buySlot, beforeRaw, unitsRaw }) => {
      const before = uint(beforeRaw),
        units = uint(unitsRaw, true),
        acquired = uint(s.acquiredRaw, true),
        slot = uint(buySlot);
      if (
        s.wallet !== e.report.wallet ||
        s.mint !== e.report.mint ||
        slot >= BigInt(e.report.slot) ||
        before + units > acquired ||
        s.acquisitionBasisVerified !== false ||
        s.executionAllowed !== false ||
        ![s.originId, s.sha256, receiptSha256].every((h) =>
          /^[a-f0-9]{64}$/.test(h),
        )
      )
        throw new LaunchSaleAllocationError(
          'Recorded launch source, chronology or remaining units differ.',
        );
      return {
        originId: s.originId,
        sourceSha256: s.sha256,
        receiptSha256,
        buySlot,
        beforeRaw,
        unitsRaw,
        afterRaw: (before + units).toString(),
      };
    },
  );
  if (
    allocations.reduce((n, a) => n + BigInt(a.unitsRaw), 0n) !==
    uint(e.report.acquiredRaw, true)
  )
    throw new LaunchSaleAllocationError(
      'Assign the complete sale to recorded acquisitions.',
    );
  const core = {
    format: 'launch-sale-allocation-v1' as const,
    policy: LAUNCH_SALE_POLICY,
    saleReceiptId: e.receiptId,
    saleEvidenceSha256: e.sha256,
    saleSignature: e.report.signature,
    wallet: e.report.wallet,
    mint: e.report.mint,
    decimals: 6,
    saleSlot: e.report.slot,
    soldRaw: e.report.acquiredRaw,
    allocations,
    executionAllowed: false as const,
    signingAllowed: false as const,
    profitCalculated: false as const,
    acquisitionBasisVerified: false as const,
  };
  const sha256 = await pumpHolderDigest(core);
  signal.throwIfAborted();
  return { ...core, sha256 };
}
export type LaunchSaleAllocation = Awaited<
  ReturnType<typeof planLaunchSaleAllocation>
>;
