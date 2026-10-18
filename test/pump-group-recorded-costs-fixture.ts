import type {
  PumpGroupView,
  PumpGroupObservationView,
} from '../lib/pump-launch-group-client';
import type {
  PumpGroupBroadcastState,
  PumpGroupBroadcastTerminalReceipt,
} from '../lib/pump-group-broadcast';
export const recordedCostReviewId = '00000001-0000-4000-8000-000000000000';
export const recordedCostMint = 'So11111111111111111111111111111111111111112';
export const recordedCostResponse = {
  format: 'pump-group-recorded-costs-v1' as const,
  reviewId: recordedCostReviewId,
  mint: recordedCostMint,
  observedAt: '2026-10-18T10:00:00.000Z',
  outcome: 'finalized' as const,
  packets: [
    { index: 0, outcome: 'success' as const, networkFeeLamports: '5000' },
    { index: 1, outcome: 'success' as const, networkFeeLamports: '5000' },
  ],
  groupNetworkFeeLamports: '10000',
  tipNetworkFeeLamports: '5000',
  tipLamports: '1000',
  knownTotalLamports: '16000',
  feeAndTipCoverageComplete: true,
  economicSettlementVerified: false as const,
  profitCalculated: false as const,
  purchasePrincipalIncluded: false as const,
  rentIncluded: false as const,
  signingAllowed: false as const,
  executionAllowed: false as const,
  reservationsChanged: false as const,
};
/** Projection-unit inputs only. Signature/SQL/receipt parsers are tested with the real protocol fixture separately. */
export function recordedCostInputs() {
  const closure = {
    format: 'pump-launch-group-broadcast-terminal-v1',
    reviewId: recordedCostReviewId,
    contextSha256: 'a'.repeat(64),
    manifestSha256: 'f'.repeat(64),
    signedGroupSha256: 'c'.repeat(64),
    broadcastId: '00000002-0000-4000-8000-000000000000',
    broadcastSha256: 'b'.repeat(64),
    observationId: '00000004-0000-4000-8000-000000000000',
    observationSha256: 'd'.repeat(64),
    observedAt: recordedCostResponse.observedAt,
    kind: 'finalized',
    sourceState: 'signed',
    knownNetworkFeeRaw: '15000',
    groupNetworkFeeRaw: '10000',
    tipNetworkFeeRaw: '5000',
    tipDebitRaw: '1000',
    networkFeeUnresolved: false,
    reservationsReleased: true,
    economicSettlementVerified: false,
    signingAllowed: false,
    executionAllowed: false,
    completeLaunch: false,
    atomicity: 'jito-transport-requested-not-proven',
  } as PumpGroupBroadcastTerminalReceipt;
  const group = {
    state: 'finalized',
    review: {
      id: recordedCostReviewId,
      contextSha256: 'a'.repeat(64),
      input: { create: { mint: recordedCostMint } },
      packets: [{}, {}],
    },
    signedEvidence: { signedGroupSha256: 'c'.repeat(64) },
    receipt: closure,
  } as unknown as PumpGroupView;
  const observation = {
    id: '00000003-0000-4000-8000-000000000000',
    sha256: 'e'.repeat(64),
    sourceState: 'signed',
    state: 'complete',
    createdAt: recordedCostResponse.observedAt,
    receipt: {
      reviewId: recordedCostReviewId,
      signedGroupSha256: 'c'.repeat(64),
      knownNetworkFeeRaw: '10000',
      expiry: null,
      packets: [0, 1].map((index) => ({
        index,
        finalized: true,
        succeeded: true,
        slot: '250',
        networkFeeRaw: '5000',
      })),
    },
  } as unknown as PumpGroupObservationView;
  const broadcast = {
    reservationsReleased: true,
    review: {
      id: closure.broadcastId,
      sha256: closure.broadcastSha256,
      signedGroupSha256: closure.signedGroupSha256,
      tipRaw: '1000',
      tipFeeLimitRaw: '5000',
      lastValidBlockHeight: '400',
    },
    tip: { signature: 'synthetic-tip-only' },
    recovery: {
      id: closure.observationId,
      sha256: closure.observationSha256,
      observedAt: closure.observedAt,
      reviewId: recordedCostReviewId,
      groupObservationId: observation.id,
      groupObservationSha256: observation.sha256,
      state: 'finalized',
      tip: {
        signature: 'synthetic-tip-only',
        finalized: true,
        succeeded: true,
        slot: '250',
        networkFeeRaw: '5000',
        tipDebitRaw: '1000',
      },
      expiry: null,
      economicSettlementVerified: false,
      completeLaunch: false,
    },
  } as unknown as PumpGroupBroadcastState;
  return {
    group,
    broadcast,
    observation,
    closure,
    recovery: broadcast.recovery!,
  };
}
