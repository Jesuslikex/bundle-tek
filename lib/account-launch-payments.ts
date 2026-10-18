export const PUMP_PAYMENT_REASONS = [
  'receipt-unobserved',
  'balance-metadata-missing',
  'instruction-metadata-missing',
  'instruction-scope-differs',
  'native-instruction-unsupported',
  'setup-funding-unclassified',
  'native-flow-unexplained',
  'purchase-effect-differs',
] as const;
export type PumpPaymentReason = (typeof PUMP_PAYMENT_REASONS)[number];
export type PumpPaymentWallet = {
  wallet: string;
  hasBuy: boolean;
  acquiredRaw: string;
  preTokenBalanceRecovered: boolean;
  purchaseQuoteRaw: string;
  accountFundingLamports: string;
  networkFeeLamports: string;
};
export type PumpPaymentPacket = {
  index: number;
  outcome: 'success' | 'failed' | 'not-observed';
  verified: boolean;
  reason: PumpPaymentReason | null;
  networkFeeLamports: string | null;
  wallets: PumpPaymentWallet[];
};
export type AccountLaunchPayments = {
  format: 'pump-group-payments-v1';
  reviewId: string;
  mint: string;
  evidenceSha256: string;
  quoteMint: string;
  quoteDecimals: number;
  packets: PumpPaymentPacket[];
  verifiedPacketCount: number;
  purchaseQuoteSubtotalRaw: string;
  accountFundingSubtotalLamports: string;
  knownNetworkFeeLamports: string;
  complete: boolean;
  rentRecoveryVerified: false;
  venueFeeSplitVerified: false;
  acquisitionBasisVerified: false;
  tipIncluded: false;
  executionAllowed: false;
};
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9]\d{0,29})$/.test(v);
const key = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
/** Display-only response admission; payment classification grants no lot/signing authority. */
export function validatedAccountLaunchPayments(
  value: unknown,
  context: { reviewId: string; mint: string; evidenceSha256: string },
): AccountLaunchPayments {
  const v = value as AccountLaunchPayments;
  if (
    !v ||
    v.format !== 'pump-group-payments-v1' ||
    v.reviewId !== context.reviewId ||
    v.mint !== context.mint ||
    v.evidenceSha256 !== context.evidenceSha256 ||
    !key(v.quoteMint) ||
    !Number.isInteger(v.quoteDecimals) ||
    v.quoteDecimals < 0 ||
    v.quoteDecimals > 255 ||
    !Array.isArray(v.packets) ||
    !v.packets.length ||
    v.packets.length > 201 ||
    ![
      v.rentRecoveryVerified,
      v.venueFeeSplitVerified,
      v.acquisitionBasisVerified,
      v.tipIncluded,
      v.executionAllowed,
    ].every((flag) => flag === false) ||
    typeof v.complete !== 'boolean' ||
    ![
      v.purchaseQuoteSubtotalRaw,
      v.accountFundingSubtotalLamports,
      v.knownNetworkFeeLamports,
    ].every(raw)
  )
    throw new Error('Saved launch payment context differs.');
  let verified = 0,
    purchase = 0n,
    funding = 0n,
    fees = 0n;
  for (const [i, p] of v.packets.entries()) {
    if (
      !p ||
      p.index !== i ||
      !['success', 'failed', 'not-observed'].includes(p.outcome) ||
      typeof p.verified !== 'boolean' ||
      (p.networkFeeLamports !== null && !raw(p.networkFeeLamports)) ||
      !Array.isArray(p.wallets) ||
      p.wallets.length > 201 ||
      (p.verified
        ? p.reason !== null ||
          p.outcome === 'not-observed' ||
          p.networkFeeLamports === null
        : !PUMP_PAYMENT_REASONS.includes(p.reason as PumpPaymentReason) ||
          p.wallets.length !== 0) ||
      (p.outcome === 'not-observed' && p.networkFeeLamports !== null)
    )
      throw new Error('Saved launch payment packet differs.');
    if (p.networkFeeLamports !== null) fees += BigInt(p.networkFeeLamports);
    if (!p.verified) continue;
    verified++;
    const seen = new Set<string>();
    let packetFees = 0n;
    if (!p.wallets.length)
      throw new Error('Saved launch payment wallets are missing.');
    for (const w of p.wallets) {
      if (
        !w ||
        !key(w.wallet) ||
        seen.has(w.wallet) ||
        typeof w.hasBuy !== 'boolean' ||
        typeof w.preTokenBalanceRecovered !== 'boolean' ||
        (w.preTokenBalanceRecovered && !w.hasBuy) ||
        ![
          w.acquiredRaw,
          w.purchaseQuoteRaw,
          w.accountFundingLamports,
          w.networkFeeLamports,
        ].every(raw) ||
        (w.hasBuy
          ? w.acquiredRaw === '0' ||
            w.purchaseQuoteRaw === '0' ||
            p.outcome !== 'success'
          : w.acquiredRaw !== '0' || w.purchaseQuoteRaw !== '0') ||
        (p.outcome === 'failed' && w.accountFundingLamports !== '0')
      )
        throw new Error('Saved launch wallet payments differ.');
      seen.add(w.wallet);
      purchase += BigInt(w.purchaseQuoteRaw);
      funding += BigInt(w.accountFundingLamports);
      packetFees += BigInt(w.networkFeeLamports);
    }
    if (packetFees !== BigInt(p.networkFeeLamports!))
      throw new Error('Saved launch payment fees do not reconcile.');
  }
  if (
    v.verifiedPacketCount !== verified ||
    v.complete !== (verified === v.packets.length) ||
    v.purchaseQuoteSubtotalRaw !== purchase.toString() ||
    v.accountFundingSubtotalLamports !== funding.toString() ||
    v.knownNetworkFeeLamports !== fees.toString()
  )
    throw new Error('Saved launch payment totals do not reconcile.');
  return v;
}
