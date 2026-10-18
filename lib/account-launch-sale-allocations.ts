import { launchPurchaseDigest } from './account-launch-purchases';
import { UUID } from './wallet-operation';

/** Client admission for the sale-allocations and sale-evidence HTTP contracts.
 * Responses that differ from the exact reviewed shape are refused. */
export type LaunchSaleAllocationRow = {
  originId: string;
  sourceSha256: string;
  receiptSha256: string;
  buySlot: string;
  beforeRaw: string;
  unitsRaw: string;
  afterRaw: string;
};
export type LaunchSaleAllocationPlan = {
  format: 'launch-sale-allocation-v1';
  policy: 'recorded-launch-units-v1';
  saleReceiptId: string;
  saleEvidenceSha256: string;
  saleSignature: string;
  wallet: string;
  mint: string;
  decimals: 6;
  saleSlot: string;
  soldRaw: string;
  allocations: LaunchSaleAllocationRow[];
  executionAllowed: false;
  signingAllowed: false;
  profitCalculated: false;
  acquisitionBasisVerified: false;
  sha256: string;
};
export type SaleEvidenceSummary = {
  receiptId: string;
  mint: string;
  wallet: string;
  entry: null | {
    sha256: string;
    observedAt: string;
    slot: string;
    tokenUnitsRaw: string;
    networkFeeLamports: string;
    nativeSettlementRaw: string;
    executionAllowed: false;
    profitCalculated: false;
  };
};
export type SaleContext = {
  saleReceiptId: string;
  wallet: string;
  mint: string;
};

const raw = (v: unknown, positive = false): v is string =>
  typeof v === 'string' &&
  (positive ? /^[1-9]\d{0,19}$/ : /^(0|[1-9]\d{0,19})$/).test(v) &&
  BigInt(v) <= 18446744073709551615n;
const slot = (v: unknown): v is string =>
  (typeof v === 'string' && /^(0|[1-9]\d{0,19})$/.test(v)) ||
  (Number.isSafeInteger(v) && Number(v) >= 0);
const hash = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: unknown, expected: string) =>
  object(v) &&
  Object.keys(v).sort().join(',') === expected.split(',').sort().join(',');
const fail = (): never => {
  throw new Error(
    'The sale acquisition response differs. Reload the sale before saving.',
  );
};

export async function validatedLaunchSalePlan(
  value: unknown,
  context: SaleContext,
  selection?: { originId: string; unitsRaw: string }[],
): Promise<LaunchSaleAllocationPlan> {
  const v = value as LaunchSaleAllocationPlan;
  if (
    !keys(
      v,
      'format,policy,saleReceiptId,saleEvidenceSha256,saleSignature,wallet,mint,decimals,saleSlot,soldRaw,allocations,executionAllowed,signingAllowed,profitCalculated,acquisitionBasisVerified,sha256',
    ) ||
    v.format !== 'launch-sale-allocation-v1' ||
    v.policy !== 'recorded-launch-units-v1' ||
    v.saleReceiptId !== context.saleReceiptId ||
    v.wallet !== context.wallet ||
    v.mint !== context.mint ||
    v.decimals !== 6 ||
    !hash(v.saleEvidenceSha256) ||
    typeof v.saleSignature !== 'string' ||
    !slot(v.saleSlot) ||
    !raw(v.soldRaw, true) ||
    v.executionAllowed !== false ||
    v.signingAllowed !== false ||
    v.profitCalculated !== false ||
    v.acquisitionBasisVerified !== false ||
    !hash(v.sha256) ||
    !Array.isArray(v.allocations) ||
    v.allocations.length < 1 ||
    v.allocations.length > 8
  )
    return fail();
  let total = 0n;
  const seen = new Set<string>();
  for (const a of v.allocations) {
    if (
      !keys(
        a,
        'originId,sourceSha256,receiptSha256,buySlot,beforeRaw,unitsRaw,afterRaw',
      ) ||
      !hash(a.originId) ||
      seen.has(a.originId) ||
      !hash(a.sourceSha256) ||
      !hash(a.receiptSha256) ||
      !slot(a.buySlot) ||
      BigInt(a.buySlot) >= BigInt(v.saleSlot) ||
      !raw(a.beforeRaw) ||
      !raw(a.unitsRaw, true) ||
      !raw(a.afterRaw) ||
      BigInt(a.beforeRaw) + BigInt(a.unitsRaw) !== BigInt(a.afterRaw)
    )
      return fail();
    seen.add(a.originId);
    total += BigInt(a.unitsRaw);
  }
  if (total !== BigInt(v.soldRaw)) return fail();
  if (
    selection &&
    [...selection]
      .sort((a, b) => a.originId.localeCompare(b.originId))
      .map((s) => `${s.originId}:${s.unitsRaw}`)
      .join(',') !==
      [...v.allocations]
        .sort((a, b) => a.originId.localeCompare(b.originId))
        .map((s) => `${s.originId}:${s.unitsRaw}`)
        .join(',')
  )
    return fail();
  const { sha256, ...core } = v;
  if ((await launchPurchaseDigest(core)) !== sha256) return fail();
  return v;
}

export async function validatedLaunchSaleRead(
  value: unknown,
  context: SaleContext,
) {
  const v = value as {
    saleReceiptId: string;
    plan: unknown;
    executionAllowed: false;
    profitCalculated: false;
  };
  if (
    !keys(v, 'saleReceiptId,plan,executionAllowed,profitCalculated') ||
    v.saleReceiptId !== context.saleReceiptId ||
    v.executionAllowed !== false ||
    v.profitCalculated !== false
  )
    return fail();
  return v.plan === null ? null : validatedLaunchSalePlan(v.plan, context);
}

export function validatedSaleEvidence(
  value: unknown,
  context: SaleContext,
): SaleEvidenceSummary {
  const v = value as SaleEvidenceSummary;
  if (
    !keys(v, 'receiptId,mint,wallet,entry') ||
    v.receiptId !== context.saleReceiptId ||
    v.mint !== context.mint ||
    v.wallet !== context.wallet ||
    !UUID.test(v.receiptId)
  )
    return fail();
  const e = v.entry;
  if (
    e !== null &&
    (!keys(
      e,
      'sha256,observedAt,slot,tokenUnitsRaw,networkFeeLamports,nativeSettlementRaw,executionAllowed,profitCalculated',
    ) ||
      !hash(e.sha256) ||
      typeof e.observedAt !== 'string' ||
      !slot(e.slot) ||
      !raw(e.tokenUnitsRaw, true) ||
      !raw(e.networkFeeLamports) ||
      typeof e.nativeSettlementRaw !== 'string' ||
      !/^-?(0|[1-9]\d{0,29})$/.test(e.nativeSettlementRaw) ||
      e.executionAllowed !== false ||
      e.profitCalculated !== false)
  )
    return fail();
  return v;
}

/** Whole-number raw units the owner typed, or null when not an exact count. */
export function rawUnitsInput(text: string) {
  const t = text.trim();
  return raw(t, true) ? t : null;
}
