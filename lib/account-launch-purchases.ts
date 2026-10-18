import type {
  PumpPurchaseCostPlan,
  PumpPurchaseCostSource,
} from './pump-purchase-costs';
import { launchEvidenceId } from './account-launch-evidence';
import {
  PUMP_PAYMENT_REASONS,
  type PumpPaymentReason,
} from './account-launch-payments';
// The HTTP contract carries wallet strings, without the builder's SDK brand.
export type AccountLaunchPurchasePlan = Omit<
  PumpPurchaseCostPlan,
  'omitted'
> & {
  omitted: {
    packetIndex: number;
    wallet: string;
    reason: PumpPaymentReason | 'purchase-not-verified';
  }[];
};
export type AccountLaunchPurchaseView = {
  reviewId: string;
  receiptId: string;
  plan: AccountLaunchPurchasePlan;
  recordedOriginIds: string[];
  saved: boolean;
};
export type AccountLaunchPurchaseHistory = {
  reviewId: string;
  sources: PumpPurchaseCostSource[];
  acquisitionBasisVerified: false;
  profitCalculated: false;
  executionAllowed: false;
};
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9]\d{0,29})$/.test(v);
const hash = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const key = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
const index = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 200;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: unknown, expected: string) =>
  object(v) &&
  Object.keys(v).sort().join(',') === expected.split(',').sort().join(',');
const fail = (): never => {
  throw new Error(
    'The saved buy cost response differs. Reload it before saving.',
  );
};
export const canonicalLaunchPurchaseJson = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((k) => [k, item[k]]),
        )
      : item,
  );
export async function launchPurchaseDigest(value: unknown) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalLaunchPurchaseJson(value)),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
async function source(
  value: unknown,
  context: { reviewId: string; mint: string },
): Promise<PumpPurchaseCostSource> {
  const s = value as PumpPurchaseCostSource;
  if (
    !keys(
      s,
      'originId,reviewId,packetIndex,signatureSha256,wallet,mint,quoteMint,quoteDecimals,acquiredRaw,purchaseQuoteRaw,packetFeeShareLamports,tipShareLamports,tipFeeShareLamports,executionCostLamports,nativeTradeCostExcludingSetupLamports,walletSetupFundingLamports,policy,acquisitionBasisVerified,executionAllowed,sha256',
    ) ||
    s.reviewId !== context.reviewId ||
    s.mint !== context.mint ||
    !key(s.wallet) ||
    !key(s.mint) ||
    !key(s.quoteMint) ||
    !hash(s.originId) ||
    !hash(s.signatureSha256) ||
    !hash(s.sha256) ||
    !index(s.packetIndex) ||
    !Number.isInteger(s.quoteDecimals) ||
    s.quoteDecimals < 0 ||
    s.quoteDecimals > 255 ||
    (s.quoteMint === 'So11111111111111111111111111111111111111112' &&
      s.quoteDecimals !== 9) ||
    s.policy !== 'reviewed-buy-shares-v1' ||
    s.acquisitionBasisVerified !== false ||
    s.executionAllowed !== false ||
    ![
      s.acquiredRaw,
      s.purchaseQuoteRaw,
      s.packetFeeShareLamports,
      s.tipShareLamports,
      s.tipFeeShareLamports,
      s.executionCostLamports,
      s.walletSetupFundingLamports,
    ].every(raw)
  )
    return fail();
  const execution =
    BigInt(s.packetFeeShareLamports) +
    BigInt(s.tipShareLamports) +
    BigInt(s.tipFeeShareLamports);
  if (
    BigInt(s.acquiredRaw) < 1n ||
    BigInt(s.purchaseQuoteRaw) < 1n ||
    s.executionCostLamports !== execution.toString() ||
    s.nativeTradeCostExcludingSetupLamports !==
      (s.quoteMint === 'So11111111111111111111111111111111111111112'
        ? (BigInt(s.purchaseQuoteRaw) + execution).toString()
        : null)
  )
    return fail();
  const { sha256, ...core } = s;
  if (
    (await launchPurchaseDigest(core)) !== sha256 ||
    (await launchPurchaseDigest({
      network: 'solana-mainnet',
      signatureSha256: s.signatureSha256,
      mint: s.mint,
      wallet: s.wallet,
    })) !== s.originId
  )
    return fail();
  return s;
}
async function sources(
  values: unknown,
  context: { reviewId: string; mint: string },
) {
  if (!Array.isArray(values) || values.length > 201) return fail();
  const seen = new Set<string>(),
    intents = new Set<string>(),
    result: PumpPurchaseCostSource[] = [];
  for (const value of values) {
    const s = await source(value, context),
      intent = s.packetIndex + ':' + s.wallet;
    if (seen.has(s.originId) || intents.has(intent)) return fail();
    seen.add(s.originId);
    intents.add(intent);
    result.push(s);
  }
  if (
    result.some(
      (s) =>
        s.quoteMint !== result[0].quoteMint ||
        s.quoteDecimals !== result[0].quoteDecimals,
    )
  )
    return fail();
  return result;
}
export async function validatedLaunchPurchaseView(
  value: unknown,
  context: {
    reviewId: string;
    mint: string;
    receiptId: string;
    receiptSha256?: string;
  },
): Promise<AccountLaunchPurchaseView> {
  const v = value as AccountLaunchPurchaseView,
    p = v?.plan;
  if (
    !keys(v, 'reviewId,receiptId,plan,recordedOriginIds,saved') ||
    v.reviewId !== context.reviewId ||
    v.receiptId !== context.receiptId ||
    !launchEvidenceId(v.reviewId) ||
    !launchEvidenceId(v.receiptId) ||
    typeof v.saved !== 'boolean' ||
    !keys(
      p,
      'format,policy,reviewId,mint,contextSha256,signedGroupSha256,receiptSha256,settlementCostsSha256,reviewedBuyCount,sources,omitted,unknownFeePackets,knownPacketFeesLamports,unallocatedPacketFeesLamports,unallocatedTipLamports,unallocatedTipFeeLamports,knownSetupFundingLamports,unallocatedSetupFundingLamports,allocationComplete,acquisitionBasisVerified,profitCalculated,signingAllowed,executionAllowed,reservationsChanged,sha256',
    ) ||
    p.format !== 'pump-purchase-cost-allocation-v1' ||
    p.policy !== 'reviewed-buy-shares-v1' ||
    p.reviewId !== context.reviewId ||
    p.mint !== context.mint ||
    ![
      p.contextSha256,
      p.signedGroupSha256,
      p.receiptSha256,
      p.settlementCostsSha256,
      p.sha256,
    ].every(hash) ||
    (context.receiptSha256 !== undefined &&
      p.receiptSha256 !== context.receiptSha256) ||
    !Number.isSafeInteger(p.reviewedBuyCount) ||
    p.reviewedBuyCount < 0 ||
    p.reviewedBuyCount > 201 ||
    typeof p.allocationComplete !== 'boolean' ||
    ![
      p.acquisitionBasisVerified,
      p.profitCalculated,
      p.signingAllowed,
      p.executionAllowed,
      p.reservationsChanged,
    ].every((flag) => flag === false) ||
    ![
      p.knownPacketFeesLamports,
      p.unallocatedPacketFeesLamports,
      p.unallocatedTipLamports,
      p.unallocatedTipFeeLamports,
      p.knownSetupFundingLamports,
      p.unallocatedSetupFundingLamports,
    ].every(raw) ||
    !Array.isArray(p.omitted) ||
    p.omitted.length > 201 ||
    !Array.isArray(p.unknownFeePackets) ||
    p.unknownFeePackets.length > 201 ||
    !Array.isArray(v.recordedOriginIds) ||
    v.recordedOriginIds.length > 201
  )
    return fail();
  const rows = await sources(p.sources, context),
    intents = new Set(rows.map((s) => s.packetIndex + ':' + s.wallet));
  for (const o of p.omitted) {
    if (
      !keys(o, 'packetIndex,wallet,reason') ||
      !index(o.packetIndex) ||
      !key(o.wallet) ||
      ![...PUMP_PAYMENT_REASONS, 'purchase-not-verified'].includes(o.reason) ||
      intents.has(o.packetIndex + ':' + o.wallet)
    )
      return fail();
    intents.add(o.packetIndex + ':' + o.wallet);
  }
  const unknown = new Set(p.unknownFeePackets);
  if (
    p.unknownFeePackets.some((i) => !index(i)) ||
    unknown.size !== p.unknownFeePackets.length ||
    rows.some((s) => unknown.has(s.packetIndex)) ||
    rows.length + p.omitted.length !== p.reviewedBuyCount ||
    (p.allocationComplete && (p.omitted.length > 0 || unknown.size > 0))
  )
    return fail();
  const total = (
    field: 'packetFeeShareLamports' | 'walletSetupFundingLamports',
  ) => rows.reduce((sum, s) => sum + BigInt(s[field]), 0n);
  if (
    (
      total('packetFeeShareLamports') + BigInt(p.unallocatedPacketFeesLamports)
    ).toString() !== p.knownPacketFeesLamports ||
    (
      total('walletSetupFundingLamports') +
      BigInt(p.unallocatedSetupFundingLamports)
    ).toString() !== p.knownSetupFundingLamports
  )
    return fail();
  const recorded = new Set(v.recordedOriginIds);
  if (
    recorded.size !== v.recordedOriginIds.length ||
    v.recordedOriginIds.some(
      (id) => !hash(id) || !rows.some((s) => s.originId === id),
    ) ||
    (v.saved && (!rows.length || recorded.size !== rows.length))
  )
    return fail();
  const { sha256, ...core } = p;
  if ((await launchPurchaseDigest(core)) !== sha256) return fail();
  return v;
}
export async function validatedLaunchPurchaseHistory(
  value: unknown,
  context: { reviewId: string; mint: string },
): Promise<AccountLaunchPurchaseHistory> {
  const v = value as AccountLaunchPurchaseHistory;
  if (
    !keys(
      v,
      'reviewId,sources,acquisitionBasisVerified,profitCalculated,executionAllowed',
    ) ||
    v.reviewId !== context.reviewId ||
    !launchEvidenceId(v.reviewId) ||
    v.acquisitionBasisVerified !== false ||
    v.profitCalculated !== false ||
    v.executionAllowed !== false
  )
    return fail();
  await sources(v.sources, context);
  return v;
}
