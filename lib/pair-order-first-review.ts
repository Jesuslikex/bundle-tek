import type { prepareOwnedImportedPairOrder } from './imported-pair-order-candidate';
import type { ImportedPairQuote } from './imported-trade-pair';
import { assertPairOrderQuoteBounds } from './pair-order-quote-bounds';
import { pairRuntimeDigest } from './pair-runtime-trace';
import { pairWalletUint } from './pair-wallet-evidence';
import { pairUiAmount } from './pair-ui-amount';
import type { PairOrderMarketBound } from './pair-order-market-bound';

export type PairOrderCandidate = Awaited<
  ReturnType<typeof prepareOwnedImportedPairOrder>
>;
export type PairOrderFirstReview = Awaited<
  ReturnType<typeof buildPairOrderFirstReview>
>;
export type PairOrderFirstConsent = {
  reviewSha256: string;
  packetSha256: string;
  approvedMinimumOutputRaw: string;
  approveExactOrder: true;
  acknowledgeIndependentDifference: boolean;
};

/** Only deterioration above 2% requires acknowledgement. Improvements remain visible. */
export function pairIndependentDifference(
  minimum: string,
  previewExpected: string,
) {
  const actual = pairWalletUint(minimum),
    baseline = pairWalletUint(previewExpected);
  if (actual < 1n || baseline < 1n)
    throw Error('Positive output evidence required.');
  const delta = actual - baseline;
  return {
    source: 'initial-jupiter-preview' as const,
    baselineOutputRaw: baseline.toString(),
    differenceRaw: delta.toString(),
    // Truncation is display-only. The acknowledgement uses the exact cross-product.
    differenceBps: ((delta * 10000n) / baseline).toString(),
    acknowledgementRequired: delta < 0n && -delta * 10000n > baseline * 200n,
  };
}

/** A new review approves this packet's minimum, never modifies an earlier approval. */
export async function buildPairOrderFirstReview(
  candidate: PairOrderCandidate,
  initialPreview: ImportedPairQuote,
  absoluteMinimumRaw: string | null,
  now: number,
  market: PairOrderMarketBound = {
    available: false,
    reason: 'No fresh saved market observation is available.',
    acknowledgementRequired: false,
  },
) {
  const { preflight, order, review } = candidate,
    reference = preflight.quote;
  assertPairOrderQuoteBounds(reference, order, preflight.wallet);
  const minimum = pairWalletUint(order.minimumOutAmount),
    absolute =
      absoluteMinimumRaw === null ? null : pairWalletUint(absoluteMinimumRaw);
  if (absolute !== null && (absolute < 1n || minimum < absolute))
    throw Error(
      'Order is below your absolute minimum. Request a fresh review.',
    );
  const sameAsset = (
    a: typeof reference.pair.base,
    b: typeof reference.pair.base,
  ) => JSON.stringify(a) === JSON.stringify(b);
  if (
    initialPreview.pair.projectId !== reference.pair.projectId ||
    initialPreview.pair.projectRevision !== reference.pair.projectRevision ||
    initialPreview.pair.projectDocumentSha256 !==
      reference.pair.projectDocumentSha256 ||
    !sameAsset(initialPreview.pair.base, reference.pair.base) ||
    !sameAsset(initialPreview.pair.quote, reference.pair.quote) ||
    initialPreview.side !== reference.side ||
    initialPreview.inputRaw !== reference.inputRaw ||
    Date.parse(initialPreview.quote.observedAt) >
      Date.parse(order.observedAt) ||
    Date.parse(reference.quote.observedAt) < Date.parse(order.observedAt) ||
    !Number.isFinite(now) ||
    Date.parse(initialPreview.quote.expiresAt) <= now ||
    Date.parse(initialPreview.quote.observedAt) > now ||
    !candidate.economicSimulationVerified ||
    review.packetSha256 !== order.preparation.sha256 ||
    review.assessment.minimumOutputRaw !== order.minimumOutAmount ||
    review.assessment.rawInput !== order.inAmount ||
    review.assessment.route.status !== 'Matched fields' ||
    !review.assessment.route.decoded ||
    review.maximumSlot - review.minimumSlot > 32
  )
    throw Error(
      'Order, independent preview, decoded route or review context changed.',
    );
  const expiresAt = Math.min(
    Date.parse(review.expiresAt),
    Date.parse(order.expiresAt),
    Date.parse(initialPreview.quote.expiresAt),
    market.available ? Date.parse(market.expiresAt) : Infinity,
  );
  if (!Number.isFinite(expiresAt) || now >= expiresAt)
    throw Error('Request a new order review.');
  const terms = {
    format: 'pair-order-first-review-v1' as const,
    projectId: reference.pair.projectId,
    projectRevision: reference.pair.projectRevision,
    wallet: preflight.wallet,
    walletRevision: preflight.walletRevision,
    requestedInputAmount: reference.requestedInputAmount,
    feeAndRentLimitRaw: preflight.funding.userFeeAndRentLimitRaw,
    side: reference.side,
    inputMint: order.inputMint,
    outputMint: order.outputMint,
    inputRaw: order.inAmount,
    display: {
      inputSymbol: (reference.side === 'Buy'
        ? reference.pair.quote
        : reference.pair.base
      ).symbol,
      outputSymbol: (reference.side === 'Buy'
        ? reference.pair.base
        : reference.pair.quote
      ).symbol,
      inputAmount: reference.inputAmount,
      expectedOutputAmount: pairUiAmount(
        order.outAmount,
        (reference.side === 'Buy' ? reference.pair.base : reference.pair.quote)
          .decimals,
        (reference.side === 'Buy' ? reference.pair.base : reference.pair.quote)
          .amountPolicy,
        reference.pair.mintPolicy.recheckUnixTimestamp,
      ),
      minimumOutputAmount: pairUiAmount(
        order.minimumOutAmount,
        (reference.side === 'Buy' ? reference.pair.base : reference.pair.quote)
          .decimals,
        (reference.side === 'Buy' ? reference.pair.base : reference.pair.quote)
          .amountPolicy,
        reference.pair.mintPolicy.recheckUnixTimestamp,
      ),
    },
    expectedOutputRaw: order.outAmount,
    minimumOutputRaw: order.minimumOutAmount,
    absoluteMinimumRaw,
    slippageBps: 50 as const,
    freshReferenceOutputRaw: reference.quote.outAmount,
    freshReferenceMinimumRaw: reference.quote.minimumOutAmount,
    freshReferenceObservedAt: reference.quote.observedAt,
    previewComparison: {
      ...pairIndependentDifference(
        order.minimumOutAmount,
        initialPreview.quote.outAmount,
      ),
      observedAt: initialPreview.quote.observedAt,
    },
    marketComparison: market,
    acknowledgementRequired:
      pairIndependentDifference(
        order.minimumOutAmount,
        initialPreview.quote.outAmount,
      ).acknowledgementRequired || market.acknowledgementRequired,
    route: review.assessment.route.decoded.steps.map((s) => ({
      venue: s.venue,
      bps: s.bps,
      inputIndex: s.inputIndex,
      outputIndex: s.outputIndex,
    })),
    // Provider estimate only; venue identities above are decoded from the exact packet.
    priceImpactPct: order.priceImpactPct ?? null,
    networkFeeRaw: review.assessment.networkFeeRaw,
    priorityFeeUpperBoundRaw: review.assessment.priorityFeeUpperBoundRaw,
    rentRaw: review.assessment.accountCreationRentRaw,
    platformFee: order.platformFee ?? null,
    packetSha256: review.packetSha256,
    candidateSha256: review.sha256,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
  return { ...terms, sha256: await pairRuntimeDigest(terms) };
}

export async function requirePairOrderFirstConsent(
  review: PairOrderFirstReview,
  consent: PairOrderFirstConsent,
  now: number,
) {
  const { sha256, ...terms } = review;
  if (
    (await pairRuntimeDigest(terms)) !== sha256 ||
    !Number.isFinite(now) ||
    now < Date.parse(review.createdAt) ||
    now >= Date.parse(review.expiresAt) ||
    !consent ||
    Object.keys(consent).sort().join(',') !==
      'acknowledgeIndependentDifference,approveExactOrder,approvedMinimumOutputRaw,packetSha256,reviewSha256' ||
    consent.approveExactOrder !== true ||
    typeof consent.acknowledgeIndependentDifference !== 'boolean' ||
    consent.reviewSha256 !== sha256 ||
    consent.packetSha256 !== review.packetSha256 ||
    consent.approvedMinimumOutputRaw !== review.minimumOutputRaw ||
    (review.acknowledgementRequired &&
      consent.acknowledgeIndependentDifference !== true)
  )
    throw Error(
      'Approve this exact unexpired order and its independent comparison. Expiry requires a new review.',
    );
}
