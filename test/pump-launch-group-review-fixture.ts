import { pumpLaunchGroupSimulationFixture } from './pump-launch-group-simulation-fixture';
import { DEFAULT_LAUNCH_PLAN } from '../lib/launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  validateProjectDocument,
} from '../lib/workspace-project';
import { encodePumpSigningInput } from '../lib/pump-launch-signing';
import { pumpHolderDigest } from '../lib/pump-holder-review';
import { pumpHolderAllowanceDigest } from '../lib/pump-holder-review-plan';
import {
  type PumpLaunchGroupReview,
  type PumpLaunchGroupConsent,
} from '../lib/pump-launch-group-review';

export async function pumpLaunchGroupReviewFixture() {
  // Uses actual collector and independent controlled accounting. No real RPC/BPF/signing.
  const f = await pumpLaunchGroupSimulationFixture(false, false, false, false),
    simulation = await f.run();

  const document = validateProjectDocument({
    plan: {
      ...DEFAULT_LAUNCH_PLAN,
      tokenName: f.input.create.name,
      ticker: f.input.create.symbol,
      developerBuy: 0.1,
      holdersBuy: 0.3000015,
      holderCount: 18,
      holdersDistribution: {
        kind: 'custom',
        weights: f.input.holders.map((h) =>
          h.kind === 'exact-base-output' ? h.tokenAmountRaw : '0',
        ),
        deviationPercent: 0,
        seed: 'a'.repeat(32),
      },
    },
    identity: EMPTY_IDENTITY,
    options: {
      ...DEFAULT_VENUE_OPTIONS,
      wallets: {
        chain: 'Solana',
        deployer: {
          address: f.input.create.payer,
          revision: 1,
          folderRevision: 0,
          root: true,
        },
        recipients: f.input.holders.map((h) => ({
          address: h.address,
          revision: 1,
          folderRevision: 0,
          root: true,
        })),
      },
    },
  });
  const context: Omit<PumpLaunchGroupReview, 'contextSha256'> = {
    format: 'pump-launch-group-review-v1',
    id: crypto.randomUUID(),
    projectId: 'synthetic-group-review',
    projectUpdatedAt: new Date().toISOString(),
    releaseId: 'a'.repeat(64),
    expiresAt: simulation.expiresAt,
    manifestSha256: f.group.manifestSha256,
    packets: f.group.packets.map((packet, index) => ({
      index,
      transaction: packet.transaction,
      sha256: packet.packetSha256,
      requiredSigners: [...packet.requiredSigners],
      holderIndices: [...packet.holderIndices],
    })),
    input: { ...f.input, create: encodePumpSigningInput(f.input.create) },
    document,
    allowances: f.limits,
    deployerBindingSha256: 'b'.repeat(64),
    holderBindingSha256: 'c'.repeat(64),
    allowanceSha256: await pumpHolderAllowanceDigest(f.limits),
    simulation,
    simulationSha256: await pumpHolderDigest(simulation),
  };
  const review = { ...context, contextSha256: await pumpHolderDigest(context) };
  const consent: PumpLaunchGroupConsent = {
    approved: true,
    reviewId: review.id,
    manifestSha256: review.manifestSha256,
    contextSha256: review.contextSha256,
    simulationSha256: review.simulationSha256,
    approvedScope: 'complete-create-developer-holder-packet-group',
    acknowledgeSimulationLimits: true,
  };

  return { review, consent, fixture: f };
}
