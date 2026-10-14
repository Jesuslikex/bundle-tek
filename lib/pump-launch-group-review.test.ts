import { beforeAll, expect, it } from 'vitest';
import { pumpLaunchGroupReviewFixture } from '../test/pump-launch-group-review-fixture';
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
  const f = await pumpLaunchGroupReviewFixture();
  review = f.review;
  consent = f.consent;
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
