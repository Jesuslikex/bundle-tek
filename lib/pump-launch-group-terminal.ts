import type { PumpLaunchGroupReview } from './pump-launch-group-review';
import { pumpHolderDigest } from './pump-holder-review';
import type { collectOwnedPumpGroupObservation } from './pump-launch-group-observation-service';
export type PumpGroupTerminalReceipt = {
  format: 'pump-launch-group-terminal-recovery-v1';
  kind: 'expired-unobserved' | 'all-packets-failed';
  reviewId: string;
  contextSha256: string;
  manifestSha256: string;
  signedGroupSha256: string | null;
  observationId: string;
  observationSha256: string;
  observedAt: string;
  sourceState: 'approved' | 'signed';
  knownNetworkFeeRaw: string;
  networkFeeUnresolved: boolean;
  reservationsReleased: true;
  economicSettlementVerified: false;
  signingAllowed: false;
  executionAllowed: false;
  completeLaunch: false;
};
type Observation = Awaited<ReturnType<typeof collectOwnedPumpGroupObservation>>;
/** Terminal pending-transaction proof only. Partial/unknown/success accounting never becomes automatic release. */
export async function pumpGroupTerminalCandidate(
  review: PumpLaunchGroupReview,
  observation: Observation,
  now = Date.now(),
): Promise<PumpGroupTerminalReceipt | null> {
  const receipt = observation.receipt;
  if (
    receipt.reviewId !== review.id ||
    receipt.contextSha256 !== review.contextSha256 ||
    receipt.manifestSha256 !== review.manifestSha256 ||
    !['approved', 'signed'].includes(observation.sourceState) ||
    receipt.network !== 'mainnet' ||
    receipt.commitment !== 'finalized' ||
    receipt.mint !== review.input.create.mint ||
    receipt.packets.length !== review.packets.length ||
    !Number.isFinite(Date.parse(observation.createdAt)) ||
    now - Date.parse(observation.createdAt) < 0 ||
    now - Date.parse(observation.createdAt) > 5000 ||
    observation.createdAt !== receipt.observedAt ||
    observation.sha256 !==
      (await pumpHolderDigest({ state: observation.state, receipt }))
  )
    throw new Error('Fresh owned group recovery evidence differs.');
  const expiry = receipt.expiry;
  const expired =
    observation.state === 'expired-unobserved' &&
    receipt.observedPacketCount === 0 &&
    receipt.successfulPacketCount === 0 &&
    receipt.packets.every(
      (p, i) =>
        p.index === i &&
        p.unsignedPacketSha256 === review.packets[i].sha256 &&
        !p.finalized &&
        p.succeeded === null &&
        p.slot === null &&
        p.networkFeeRaw === null,
    ) &&
    expiry?.pastExpiryMargin === true &&
    expiry.marginBlocks === 32 &&
    expiry.mintAbsent === true &&
    expiry.lastValidBlockHeight === review.input.create.lastValidBlockHeight &&
    /^\d{1,16}$/.test(expiry.finalizedBlockHeight) &&
    BigInt(expiry.finalizedBlockHeight) >
      BigInt(review.input.create.lastValidBlockHeight) + 32n &&
    expiry.mintObservedSlot !== null &&
    BigInt(expiry.mintObservedSlot) >= BigInt(expiry.expiryBankSlot);
  const failed =
    observation.state === 'failed' &&
    observation.sourceState === 'signed' &&
    receipt.signedGroupSha256 !== null &&
    receipt.allPacketsFinalized &&
    !receipt.allPacketsSucceeded &&
    !receipt.networkFeeUnresolved &&
    receipt.observedPacketCount === review.packets.length &&
    receipt.successfulPacketCount === 0 &&
    receipt.packets.every(
      (p, i) =>
        p.index === i &&
        p.unsignedPacketSha256 === review.packets[i].sha256 &&
        p.finalized &&
        p.succeeded === false &&
        p.slot !== null &&
        p.signature !== null &&
        p.networkFeeRaw !== null,
    );
  if (!expired && !failed) return null;
  return {
    format: 'pump-launch-group-terminal-recovery-v1',
    kind: expired ? 'expired-unobserved' : 'all-packets-failed',
    reviewId: review.id,
    contextSha256: review.contextSha256,
    manifestSha256: review.manifestSha256,
    signedGroupSha256: receipt.signedGroupSha256,
    observationId: observation.id,
    observationSha256: observation.sha256,
    observedAt: receipt.observedAt,
    sourceState: observation.sourceState as 'approved' | 'signed',
    knownNetworkFeeRaw: receipt.knownNetworkFeeRaw,
    networkFeeUnresolved: receipt.networkFeeUnresolved,
    reservationsReleased: true,
    economicSettlementVerified: false,
    signingAllowed: false,
    executionAllowed: false,
    completeLaunch: false,
  };
}
