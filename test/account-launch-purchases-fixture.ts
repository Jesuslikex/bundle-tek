import {
  launchPurchaseDigest,
  type AccountLaunchPurchaseView,
  type AccountLaunchPurchaseHistory,
} from '../lib/account-launch-purchases';
import {
  recordedCostReviewId as reviewId,
  recordedCostMint as mint,
} from './pump-group-recorded-costs-fixture';
export async function accountLaunchPurchasesFixture(tokenQuote = false) {
  const receiptId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    receiptSha256 = 'b'.repeat(64),
    signatureSha256 = 'c'.repeat(64),
    wallet = 'So11111111111111111111111111111111111111112';
  const core = {
    originId: await launchPurchaseDigest({
      network: 'solana-mainnet',
      signatureSha256,
      mint,
      wallet,
    }),
    reviewId,
    packetIndex: 0,
    signatureSha256,
    wallet,
    mint,
    quoteMint: tokenQuote
      ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      : 'So11111111111111111111111111111111111111112',
    quoteDecimals: tokenQuote ? 6 : 9,
    acquiredRaw: '1234567',
    purchaseQuoteRaw: '1000000',
    packetFeeShareLamports: '5000',
    tipShareLamports: '1000',
    tipFeeShareLamports: '5000',
    executionCostLamports: '11000',
    nativeTradeCostExcludingSetupLamports: tokenQuote ? null : '1011000',
    walletSetupFundingLamports: '3500000',
    policy: 'reviewed-buy-shares-v1' as const,
    acquisitionBasisVerified: false as const,
    executionAllowed: false as const,
  };
  const source = { ...core, sha256: await launchPurchaseDigest(core) };
  const planCore = {
    format: 'pump-purchase-cost-allocation-v1' as const,
    policy: 'reviewed-buy-shares-v1' as const,
    reviewId,
    mint,
    contextSha256: 'd'.repeat(64),
    signedGroupSha256: 'e'.repeat(64),
    receiptSha256,
    settlementCostsSha256: 'f'.repeat(64),
    reviewedBuyCount: 1,
    sources: [source],
    omitted: [],
    unknownFeePackets: [],
    knownPacketFeesLamports: '5000',
    unallocatedPacketFeesLamports: '0',
    unallocatedTipLamports: '0',
    unallocatedTipFeeLamports: '0',
    knownSetupFundingLamports: '3500000',
    unallocatedSetupFundingLamports: '0',
    allocationComplete: true,
    acquisitionBasisVerified: false as const,
    profitCalculated: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    reservationsChanged: false as const,
  };
  const view: AccountLaunchPurchaseView = {
    reviewId,
    receiptId,
    plan: { ...planCore, sha256: await launchPurchaseDigest(planCore) },
    recordedOriginIds: [],
    saved: false,
  };
  const saved = { ...view, recordedOriginIds: [source.originId], saved: true };
  const history: AccountLaunchPurchaseHistory = {
    reviewId,
    sources: [source],
    acquisitionBasisVerified: false,
    profitCalculated: false,
    executionAllowed: false,
  };
  return {
    view,
    saved,
    history,
    context: { reviewId, mint, receiptId, receiptSha256 },
  };
}
