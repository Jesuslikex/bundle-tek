import type { PairOrderFirstRequest } from '../lib/pair-order-first-service';
import type { PairOrderFirstReview } from '../lib/pair-order-first-review';
import { pairRuntimeDigest } from '../lib/pair-runtime-trace';
export const pairReviewUiRequest: PairOrderFirstRequest = {
  id: '11111111-1111-4111-8111-111111111111',
  revision: 1,
  wallet: '11111111111111111111111111111111',
  walletRevision: 1,
  side: 'Buy',
  amount: '1',
  quoteMint: 'So11111111111111111111111111111111111111112',
  feeAndRentLimitRaw: '100000',
  absoluteMinimumRaw: null,
  prepareUnsigned: true,
};
export async function pairReviewUiFixture(
  now: number,
  warning = false,
  marketWarning = false,
) {
  const terms = {
    format: 'pair-order-first-review-v1',
    projectId: pairReviewUiRequest.id,
    projectRevision: 1,
    wallet: pairReviewUiRequest.wallet,
    walletRevision: 1,
    requestedInputAmount: '1',
    feeAndRentLimitRaw: '100000',
    side: 'Buy',
    inputMint: pairReviewUiRequest.quoteMint,
    outputMint: 'CktRuQ2mttgRGs5rGzYfih6myG3u5ksHhwRPPsRF2fAM',
    inputRaw: '1000000000',
    expectedOutputRaw: '1000000',
    minimumOutputRaw: '995000',
    absoluteMinimumRaw: null,
    slippageBps: 50,
    display: {
      inputSymbol: 'SOL',
      outputSymbol: 'TEST',
      inputAmount: '1',
      expectedOutputAmount: '1',
      minimumOutputAmount: '0.995',
    },
    freshReferenceOutputRaw: '1000000',
    freshReferenceMinimumRaw: '995000',
    freshReferenceObservedAt: new Date(now).toISOString(),
    previewComparison: {
      source: 'initial-jupiter-preview',
      baselineOutputRaw: warning ? '1100000' : '1000000',
      differenceRaw: warning ? '-105000' : '-5000',
      differenceBps: warning ? '-954' : '-50',
      acknowledgementRequired: warning,
      observedAt: new Date(now).toISOString(),
    },
    marketComparison: marketWarning
      ? {
          available: true,
          source: 'saved-dexscreener-usd-observations',
          baseObservedAt: new Date(now).toISOString(),
          quoteObservedAt: new Date(now).toISOString(),
          baseMarketPair: 'base-pool',
          quoteMarketPair: 'quote-pool',
          basePriceUsd: '100',
          quotePriceUsd: '150',
          orderImpliedBasePriceUsd: '150',
          differenceBps: '5000',
          worse: true,
          acknowledgementRequired: true,
          expiresAt: new Date(now + 300000).toISOString(),
        }
      : {
          available: false,
          reason: 'No fresh saved USD observation for the exact pair asset.',
          acknowledgementRequired: false,
        },
    acknowledgementRequired: warning || marketWarning,
    route: [{ venue: 'Raydium', bps: 10000, inputIndex: 0, outputIndex: 1 }],
    priceImpactPct: '0.12',
    networkFeeRaw: '5000',
    priorityFeeUpperBoundRaw: '0',
    rentRaw: '2039280',
    platformFee: null,
    packetSha256: 'a'.repeat(64),
    candidateSha256: 'b'.repeat(64),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30000).toISOString(),
    signingAllowed: false,
    executionAllowed: false,
  };
  return {
    id: '22222222-2222-4222-8222-222222222222',
    review: {
      ...terms,
      sha256: await pairRuntimeDigest(terms),
    } as PairOrderFirstReview,
  };
}
