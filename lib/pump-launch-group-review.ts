import {
  getTransactionDecoder,
  getTransactionEncoder,
  getBase64Decoder,
} from '@solana/kit-v1';
import { buildPumpLaunchPacketGroup } from './pump-launch-packet-group';
import { decodePumpSigningInput } from './pump-launch-signing';
import { pumpHolderDigest, type PumpHolderReview } from './pump-holder-review';
import { requirePumpHolderReviewPlan } from './pump-holder-review-plan';
import { requireConsistentSolanaSlots } from './solana-rpc';
import type { collectPumpLaunchGroupSimulation } from './pump-launch-group-simulation';

type Simulation = Awaited<ReturnType<typeof collectPumpLaunchGroupSimulation>>;
export type PumpLaunchGroupReview = Omit<
  PumpHolderReview,
  'format' | 'transaction' | 'sha256'
> & {
  format: 'pump-launch-group-review-v1';
  manifestSha256: string;
  packets: {
    index: number;
    transaction: string;
    sha256: string;
    requiredSigners: string[];
    holderIndices: number[];
  }[];
  simulation: Simulation;
  simulationSha256: string;
};
export type PumpLaunchGroupConsent = {
  approved: true;
  reviewId: string;
  manifestSha256: string;
  contextSha256: string;
  simulationSha256: string;
  approvedScope: 'complete-create-developer-holder-packet-group';
  acknowledgeSimulationLimits: true;
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Reconstructs the entire immutable group. No RPC-origin, owned revision or signing permission is established here. */
export async function requirePumpLaunchGroupReview(
  supplied: PumpLaunchGroupReview,
  requireLive = true,
) {
  const review = structuredClone(supplied);
  const fields = [
    'format',
    'id',
    'projectId',
    'projectUpdatedAt',
    'releaseId',
    'expiresAt',
    'manifestSha256',
    'packets',
    'contextSha256',
    'input',
    'document',
    'allowances',
    'deployerBindingSha256',
    'holderBindingSha256',
    'allowanceSha256',
    'simulation',
    'simulationSha256',
  ];
  if (
    !review ||
    review.format !== 'pump-launch-group-review-v1' ||
    !same(Object.keys(review).sort(), fields.sort()) ||
    [
      review.id,
      review.projectId,
      review.projectUpdatedAt,
      review.releaseId,
    ].some(
      (value) => typeof value !== 'string' || !value || value.length > 256,
    ) ||
    [
      review.manifestSha256,
      review.contextSha256,
      review.deployerBindingSha256,
      review.holderBindingSha256,
      review.allowanceSha256,
      review.simulationSha256,
    ].some((value) => !/^[a-f0-9]{64}$/.test(value)) ||
    !Number.isFinite(Date.parse(review.expiresAt)) ||
    (requireLive && Date.parse(review.expiresAt) <= Date.now()) ||
    !review.input ||
    Object.keys(review.input).some(
      (key) => !['create', 'developer', 'holders'].includes(key),
    ) ||
    !Array.isArray(review.packets) ||
    review.packets.length < 1 ||
    review.packets.length > 5
  )
    throw new Error('Group review scope, identity or lifetime differs.');
  const { contextSha256, ...context } = review;
  if ((await pumpHolderDigest(context)) !== contextSha256)
    throw new Error('Group review context hash differs.');
  const create = decodePumpSigningInput(review.input.create),
    built = await buildPumpLaunchPacketGroup({ ...review.input, create });
  await requirePumpHolderReviewPlan(review, create, built.quote);
  if (
    built.manifestSha256 !== review.manifestSha256 ||
    built.packets.length !== review.packets.length
  )
    throw new Error('Group review is incomplete or its manifest differs.');
  const transactions = [];
  for (const [index, packet] of review.packets.entries()) {
    const original = built.packets[index];
    if (
      !same(Object.keys(packet).sort(), [
        'holderIndices',
        'index',
        'requiredSigners',
        'sha256',
        'transaction',
      ]) ||
      packet.index !== index ||
      packet.transaction !== original.transaction ||
      packet.sha256 !== original.packetSha256 ||
      !same(packet.requiredSigners, original.requiredSigners) ||
      !same(packet.holderIndices, original.holderIndices) ||
      typeof packet.transaction !== 'string' ||
      packet.transaction.length > 5464
    )
      throw new Error(
        'Group review packet order, bytes or signer coverage differs.',
      );
    const bytes = Uint8Array.from(atob(packet.transaction), (char) =>
        char.charCodeAt(0),
      ),
      tx = getTransactionDecoder().decode(bytes);
    if (
      bytes.length > 4096 ||
      getBase64Decoder().decode(getTransactionEncoder().encode(tx)) !==
        packet.transaction ||
      Object.values(tx.signatures).some((signature) => signature !== null) ||
      !same(
        Object.keys(tx.signatures).sort(),
        [...original.requiredSigners].sort(),
      )
    )
      throw new Error(
        'Group review requires every canonical unsigned signer set.',
      );
    transactions.push(tx);
  }
  const simulation = review.simulation;
  if (
    !simulation ||
    (await pumpHolderDigest(simulation)) !== review.simulationSha256 ||
    simulation.format !== 'pump-launch-group-simulation-v1' ||
    simulation.manifestSha256 !== built.manifestSha256 ||
    simulation.allowanceSha256 !== review.allowanceSha256 ||
    simulation.replayCount !== 1 ||
    simulation.settlementValidated !== true ||
    simulation.sequentialTraceValidated !== true ||
    simulation.rpcCollectionRequired !== false ||
    simulation.programDeploymentMetadataValidated !== true ||
    simulation.programDeploymentMetadataOnly !== true ||
    simulation.programCodeAttested !== false ||
    simulation.programDeploymentReviewRequired !== true ||
    simulation.transportReviewRequired !== true ||
    simulation.authorityReviewRequired !== true ||
    simulation.signingAllowed !== false ||
    simulation.executionAllowed !== false ||
    simulation.completeLaunch !== false ||
    !simulation.accounting ||
    simulation.accounting.manifestSha256 !== built.manifestSha256 ||
    simulation.accounting.fullGroupAccountingValidated !== true ||
    simulation.accounting.verifiedPacketCount !== built.packets.length ||
    simulation.accounting.economicPrefixesValidated !== true ||
    simulation.accounting.accountingValidated !== true ||
    simulation.accounting.rpcCollectionRequired !== false ||
    simulation.accounting.signingAllowed !== false ||
    simulation.accounting.executionAllowed !== false ||
    simulation.accounting.bankSlot !== simulation.bankSlot ||
    simulation.accounting.frames.length !== built.packets.length ||
    simulation.accounting.frames.some(
      (frame, i) =>
        frame.index !== i ||
        frame.packetSha256 !== built.packets[i].packetSha256,
    ) ||
    !Number.isFinite(Date.parse(simulation.observedAt)) ||
    Date.parse(simulation.observedAt) > Date.now() + 1000 ||
    !Number.isFinite(Date.parse(simulation.expiresAt)) ||
    Date.parse(simulation.expiresAt) <= Date.parse(simulation.observedAt) ||
    Date.parse(simulation.expiresAt) >
      Date.parse(simulation.observedAt) + 60000 ||
    Date.parse(review.expiresAt) > Date.parse(simulation.expiresAt)
  )
    throw new Error(
      'Group review simulation binding, coverage or limits differ.',
    );
  requireConsistentSolanaSlots([
    simulation.minimumSlot,
    simulation.maximumSlot,
    simulation.bankSlot,
    simulation.sourceRecheckSlot,
  ]);
  if (requireLive && Date.parse(review.expiresAt) <= Date.now())
    throw new Error('Group review expired.');
  return {
    review,
    built,
    transactions,
    ownershipVerificationRequired: true as const,
    simulationSourceVerificationRequired: true as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}

/** Validates the exact complete-group consent only. Durable approval and live ownership/source guards are separate. */
export function requirePumpLaunchGroupConsent(
  review: PumpLaunchGroupReview,
  consent: PumpLaunchGroupConsent,
) {
  if (
    !consent ||
    !same(Object.keys(consent).sort(), [
      'acknowledgeSimulationLimits',
      'approved',
      'approvedScope',
      'contextSha256',
      'manifestSha256',
      'reviewId',
      'simulationSha256',
    ]) ||
    consent.approved !== true ||
    consent.reviewId !== review.id ||
    consent.manifestSha256 !== review.manifestSha256 ||
    consent.contextSha256 !== review.contextSha256 ||
    consent.simulationSha256 !== review.simulationSha256 ||
    consent.approvedScope !== 'complete-create-developer-holder-packet-group' ||
    consent.acknowledgeSimulationLimits !== true
  )
    throw new Error(
      'Explicit approval of this complete group, simulation and limits is required.',
    );
}
