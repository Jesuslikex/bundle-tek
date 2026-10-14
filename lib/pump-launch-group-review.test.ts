import { beforeAll, expect, it } from 'vitest';
import { pumpLaunchGroupSimulationFixture } from '../test/pump-launch-group-simulation-fixture';
import { DEFAULT_LAUNCH_PLAN } from './launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  validateProjectDocument,
} from './workspace-project';
import { encodePumpSigningInput } from './pump-launch-signing';
import { pumpHolderDigest } from './pump-holder-review';
import { pumpHolderAllowanceDigest } from './pump-holder-review-plan';
import {
  requirePumpLaunchGroupReview,
  requirePumpLaunchGroupConsent,
  type PumpLaunchGroupReview,
  type PumpLaunchGroupConsent,
} from './pump-launch-group-review';

let review: PumpLaunchGroupReview, consent: PumpLaunchGroupConsent;
const rehash = async (value: PumpLaunchGroupReview) => {
  value.simulationSha256 = await pumpHolderDigest(value.simulation);
  const { contextSha256: _hash, ...context } = value;
  value.contextSha256 = await pumpHolderDigest(context);
  return value;
};
beforeAll(async () => {
  // Uses actual collector and independent controlled accounting. No real RPC/BPF/signing.
  const f = await pumpLaunchGroupSimulationFixture(false, false, false, false),
    simulation = await f.run();
  expect(f.group.packets.length).toBeGreaterThan(1);
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
  review = { ...context, contextSha256: await pumpHolderDigest(context) };
  consent = {
    approved: true,
    reviewId: review.id,
    manifestSha256: review.manifestSha256,
    contextSha256: review.contextSha256,
    simulationSha256: review.simulationSha256,
    approvedScope: 'complete-create-developer-holder-packet-group',
    acknowledgeSimulationLimits: true,
  };
}, 15000);
it('reconstructs every ordered packet, saved slot and simulation without signing permission', async () => {
  const result = await requirePumpLaunchGroupReview(review);
  expect(result.built.packets).toHaveLength(review.packets.length);
  expect(result.review.input.holders).toHaveLength(18);
  expect(result).toMatchObject({
    ownershipVerificationRequired: true,
    simulationSourceVerificationRequired: true,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(() => requirePumpLaunchGroupConsent(review, consent)).not.toThrow();
});
it('rejects altered context without a matching hash', async () => {
  const changed = structuredClone(review);
  changed.releaseId = 'different';
  await expect(requirePumpLaunchGroupReview(changed)).rejects.toThrow(
    'context hash',
  );
});
it('rejects missing, reordered and duplicate packets even with a recomputed context', async () => {
  for (const change of [
    (r: PumpLaunchGroupReview) => r.packets.pop(),
    (r: PumpLaunchGroupReview) => r.packets.reverse(),
    (r: PumpLaunchGroupReview) => {
      r.packets[1] = structuredClone(r.packets[0]);
    },
  ]) {
    const changed = structuredClone(review);
    change(changed);
    await expect(
      requirePumpLaunchGroupReview(await rehash(changed)),
    ).rejects.toThrow();
  }
});
it('rejects changed signer coverage and holder ordering', async () => {
  const changed = structuredClone(review);
  changed.packets[0].requiredSigners.pop();
  await expect(
    requirePumpLaunchGroupReview(await rehash(changed)),
  ).rejects.toThrow('signer coverage');
  const slots = structuredClone(review);
  slots.input.holders.reverse();
  await expect(
    requirePumpLaunchGroupReview(await rehash(slots)),
  ).rejects.toThrow();
});
it('rejects altered targets and allowances against the saved plan', async () => {
  const changed = structuredClone(review);
  changed.document.plan.holdersBuy = 0.4;
  await expect(
    requirePumpLaunchGroupReview(await rehash(changed)),
  ).rejects.toThrow('denomination');
  const cap = structuredClone(review);
  cap.allowances.holders[0].maximumQuoteCostRaw = '1';
  cap.allowanceSha256 = await pumpHolderAllowanceDigest(cap.allowances);
  await expect(requirePumpLaunchGroupReview(await rehash(cap))).rejects.toThrow(
    'denomination',
  );
});
it('rejects mismatched simulation packets, skipped prefixes and asserted signing permission', async () => {
  for (const change of [
    (r: PumpLaunchGroupReview) => {
      r.simulation.accounting.frames[0].packetSha256 = 'd'.repeat(64);
    },
    (r: PumpLaunchGroupReview) => {
      r.simulation.accounting.verifiedPacketCount = 1;
    },
    (r: PumpLaunchGroupReview) => {
      Object.assign(r.simulation, { signingAllowed: true });
    },
  ]) {
    const changed = structuredClone(review);
    change(changed);
    await expect(
      requirePumpLaunchGroupReview(await rehash(changed)),
    ).rejects.toThrow('simulation binding');
  }
});
it('keeps expired records inspectable but rejects live use and extended expiry', async () => {
  const changed = structuredClone(review);
  changed.expiresAt = new Date(Date.now() - 1).toISOString();
  await rehash(changed);
  await expect(requirePumpLaunchGroupReview(changed)).rejects.toThrow(
    'lifetime',
  );
  expect(
    (await requirePumpLaunchGroupReview(changed, false)).signingAllowed,
  ).toBe(false);
  const extended = structuredClone(review);
  extended.expiresAt = new Date(
    Date.parse(extended.simulation.expiresAt) + 1,
  ).toISOString();
  await expect(
    requirePumpLaunchGroupReview(await rehash(extended)),
  ).rejects.toThrow('simulation binding');
});
it('requires exact whole-group consent including simulation hash and acknowledgement', () => {
  for (const mutation of [
    { manifestSha256: 'd'.repeat(64) },
    { simulationSha256: 'd'.repeat(64) },
    { approvedScope: 'single-packet' },
    { acknowledgeSimulationLimits: false },
    { extra: true },
  ]) {
    expect(() =>
      requirePumpLaunchGroupConsent(review, {
        ...consent,
        ...mutation,
      } as PumpLaunchGroupConsent),
    ).toThrow('Explicit approval');
  }
});
