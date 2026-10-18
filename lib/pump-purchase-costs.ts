import { parsePumpGroupReceiptEvidence } from './pump-group-receipt-evidence';
import type { PumpGroupReceiptEvidence } from './pump-group-receipt-evidence';
import { projectVerifiedPumpGroupPayments } from './pump-group-payments';
import {
  validatedPumpGroupRecordedCosts,
  type PumpGroupRecordedCosts,
} from './pump-group-recorded-costs';
import { requirePumpLaunchGroupReview } from './pump-launch-group-review';
import type { PumpLaunchGroupReview } from './pump-launch-group-review';
import type { verifyPumpLaunchGroupSignatures } from './pump-launch-group-signatures';
import { pumpHolderDigest } from './pump-holder-review';
import { PUMP_NATIVE_QUOTE } from './pump-launch-config';

export const PUMP_PURCHASE_COST_POLICY = 'reviewed-buy-shares-v1' as const;
type Group = {
  review: PumpLaunchGroupReview;
  signedEvidence: Awaited<ReturnType<typeof verifyPumpLaunchGroupSignatures>>;
};
export type PumpPurchaseCostSource = {
  originId: string;
  reviewId: string;
  packetIndex: number;
  signatureSha256: string;
  wallet: string;
  mint: string;
  quoteMint: string;
  quoteDecimals: number;
  acquiredRaw: string;
  purchaseQuoteRaw: string;
  packetFeeShareLamports: string;
  tipShareLamports: string;
  tipFeeShareLamports: string;
  executionCostLamports: string;
  nativeTradeCostExcludingSetupLamports: string | null;
  walletSetupFundingLamports: string;
  policy: typeof PUMP_PURCHASE_COST_POLICY;
  acquisitionBasisVerified: false;
  executionAllowed: false;
  sha256: string;
};
const fail = (message: string): never => {
  throw new Error(message);
};
/** Integer interval partition. Failed/missing intents retain their position;
 * later observations must never change an earlier buy's allocated share. */
export function pumpPurchaseCostShare(
  total: bigint,
  index: number,
  count: number,
) {
  if (
    total < 0n ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 201 ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= count
  )
    return fail('Launch cost allocation bounds differ.');
  return (
    (total * BigInt(index + 1)) / BigInt(count) -
    (total * BigInt(index)) / BigInt(count)
  );
}

/** Internal storage input, never caller-supplied costs. The owner service must
 * independently replay the terminal broadcast proof before passing costs here.
 * Raw primary receipts are independently parsed again; this performs no RPC,
 * writes, signing, admission to acquisition lots or profit calculation. */
export async function allocatePumpPurchaseCosts(
  suppliedEvidence: PumpGroupReceiptEvidence,
  suppliedGroup: Group,
  suppliedCosts: PumpGroupRecordedCosts,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  // Detach every input before the first await, including the retained cost proof.
  const group = structuredClone(suppliedGroup),
    input = structuredClone(suppliedEvidence),
    costInput = structuredClone(suppliedCosts);
  const evidence = await parsePumpGroupReceiptEvidence(input, group, signal),
    { built, review } = await requirePumpLaunchGroupReview(group.review, false),
    payments = await projectVerifiedPumpGroupPayments(evidence, group, signal),
    costs = validatedPumpGroupRecordedCosts(costInput, {
      reviewId: review.id,
      mint: review.input.create.mint,
    });
  if (costs.packets.length !== payments.packets.length)
    return fail('Launch cost packet scope differs.');
  if (costs.tipLamports === null || costs.tipNetworkFeeLamports === null)
    return fail(
      'The finalized tip receipt and its network fee are required before saving buy costs. Reload the launch settlement history.',
    );
  const intents = built.packets.flatMap((packet, index) =>
    packet.buyerAccounts.map((buyer, packetBuyIndex) => ({
      packetIndex: index,
      packetBuyIndex,
      wallet: buyer.payer,
    })),
  );
  if (intents.length > 201) return fail('Launch buy intent capacity differs.');
  const sourceRows: PumpPurchaseCostSource[] = [],
    omitted = [],
    unknownFeePackets: number[] = [];
  let knownPacketFees = 0n;
  const tip = BigInt(costs.tipLamports),
    tipFee = BigInt(costs.tipNetworkFeeLamports),
    mergedFees = payments.packets.map((packet, index) => {
      const saved = costs.packets[index],
        observed = packet.outcome !== 'not-observed',
        savedObserved = saved.outcome !== 'unobserved';
      if (
        (observed && savedObserved && packet.outcome !== saved.outcome) ||
        (packet.networkFeeLamports !== null &&
          saved.networkFeeLamports !== null &&
          packet.networkFeeLamports !== saved.networkFeeLamports)
      )
        return fail(
          'Retained launch receipt and settlement cost proof disagree.',
        );
      const fee = packet.networkFeeLamports ?? saved.networkFeeLamports;
      if (fee === null) unknownFeePackets.push(index);
      else knownPacketFees += BigInt(fee);
      // A valid projection must describe exactly the original reviewed buyers.
      if (packet.verified && packet.outcome === 'success') {
        const actual = packet.wallets.filter((wallet) => wallet.hasBuy),
          expected = built.packets[index].buyerAccounts;
        if (
          actual.length !== expected.length ||
          expected.some(
            (buyer) => !actual.some((w) => w.wallet === buyer.payer),
          )
        )
          return fail(
            'Retained launch buy intents differ from the exact packet.',
          );
      }
      return fee;
    });
  const origins = new Set<string>();
  for (const [index, intent] of intents.entries()) {
    signal.throwIfAborted();
    const packet = payments.packets[intent.packetIndex],
      payment = packet.wallets.find(
        (w) => w.wallet === intent.wallet && w.hasBuy,
      ),
      fee = mergedFees[intent.packetIndex];
    if (
      !packet.verified ||
      packet.outcome !== 'success' ||
      !payment ||
      fee === null
    ) {
      omitted.push({
        packetIndex: intent.packetIndex,
        wallet: intent.wallet,
        reason: packet.reason ?? 'purchase-not-verified',
      });
      continue;
    }
    const signatureSha256 = await pumpHolderDigest({
        signature: group.signedEvidence.packets[intent.packetIndex].signature,
      }),
      // No review/project/workspace identity: one actual buy cannot become two
      // sources merely because the same transaction is reviewed elsewhere.
      originId = await pumpHolderDigest({
        network: 'solana-mainnet',
        signatureSha256,
        mint: payments.mint,
        wallet: intent.wallet,
      });
    if (origins.has(originId))
      return fail('Duplicate launch acquisition origin.');
    origins.add(originId);
    const packetFee = pumpPurchaseCostShare(
        BigInt(fee),
        intent.packetBuyIndex,
        built.packets[intent.packetIndex].buyerAccounts.length,
      ),
      tipShare = pumpPurchaseCostShare(tip, index, intents.length),
      tipFeeShare = pumpPurchaseCostShare(tipFee, index, intents.length),
      executionCost = packetFee + tipShare + tipFeeShare;
    const source = {
      originId,
      reviewId: review.id,
      packetIndex: intent.packetIndex,
      signatureSha256,
      wallet: intent.wallet,
      mint: payments.mint,
      quoteMint: payments.quoteMint,
      quoteDecimals: payments.quoteDecimals,
      acquiredRaw: payment.acquiredRaw,
      purchaseQuoteRaw: payment.purchaseQuoteRaw,
      packetFeeShareLamports: packetFee.toString(),
      tipShareLamports: tipShare.toString(),
      tipFeeShareLamports: tipFeeShare.toString(),
      executionCostLamports: executionCost.toString(),
      // Token quote amounts and SOL costs never share a unit or assumed peg.
      nativeTradeCostExcludingSetupLamports:
        payments.quoteMint === PUMP_NATIVE_QUOTE
          ? (BigInt(payment.purchaseQuoteRaw) + executionCost).toString()
          : null,
      walletSetupFundingLamports: payment.accountFundingLamports,
      policy: PUMP_PURCHASE_COST_POLICY,
      acquisitionBasisVerified: false as const,
      executionAllowed: false as const,
    };
    sourceRows.push({ ...source, sha256: await pumpHolderDigest(source) });
  }
  const sum = (
    field:
      | 'packetFeeShareLamports'
      | 'tipShareLamports'
      | 'tipFeeShareLamports'
      | 'walletSetupFundingLamports',
  ) => sourceRows.reduce((s, row) => s + BigInt(row[field]), 0n);
  const plan = {
    format: 'pump-purchase-cost-allocation-v1' as const,
    policy: PUMP_PURCHASE_COST_POLICY,
    reviewId: review.id,
    mint: payments.mint,
    contextSha256: review.contextSha256,
    signedGroupSha256: group.signedEvidence.signedGroupSha256,
    receiptSha256: evidence.sha256,
    settlementCostsSha256: await pumpHolderDigest(costs),
    reviewedBuyCount: intents.length,
    sources: sourceRows,
    omitted,
    unknownFeePackets,
    knownPacketFeesLamports: knownPacketFees.toString(),
    unallocatedPacketFeesLamports: (
      knownPacketFees - sum('packetFeeShareLamports')
    ).toString(),
    unallocatedTipLamports: (tip - sum('tipShareLamports')).toString(),
    unallocatedTipFeeLamports: (tipFee - sum('tipFeeShareLamports')).toString(),
    knownSetupFundingLamports: payments.accountFundingSubtotalLamports,
    unallocatedSetupFundingLamports: (
      BigInt(payments.accountFundingSubtotalLamports) -
      sum('walletSetupFundingLamports')
    ).toString(),
    allocationComplete:
      omitted.length === 0 &&
      payments.complete &&
      unknownFeePackets.length === 0,
    acquisitionBasisVerified: false as const,
    profitCalculated: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    reservationsChanged: false as const,
  };
  const sha256 = await pumpHolderDigest(plan);
  signal.throwIfAborted();
  return { ...plan, sha256 };
}
export type PumpPurchaseCostPlan = Awaited<
  ReturnType<typeof allocatePumpPurchaseCosts>
>;
