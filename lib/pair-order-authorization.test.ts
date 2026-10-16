import { afterEach, expect, it, vi } from 'vitest';
import { pairOrderFixture } from '../test/pair-order-fixture';
import { prepareOwnedImportedPairOrder } from './imported-pair-order-candidate';
import { buildPairOrderFirstReview } from './pair-order-first-review';
import {
  authorizePairOrderAfterRecheck,
  requirePairOrderSigningWindow,
} from './pair-order-authorization';
let f: Awaited<ReturnType<typeof pairOrderFixture>> | undefined;
afterEach(() => {
  f?.close();
  f = undefined;
});
async function setup() {
  const v = (f = await pairOrderFixture());
  const c = await prepareOwnedImportedPairOrder(
    v.db,
    'alice',
    v.orderRequest,
    new AbortController().signal,
    v.orderDependencies,
  );
  const r = await buildPairOrderFirstReview(
    c,
    c.preflight.quote,
    null,
    v.clock.now,
  );
  const consent = {
    reviewSha256: r.sha256,
    packetSha256: r.packetSha256,
    approvedMinimumOutputRaw: r.minimumOutputRaw,
    approveExactOrder: true as const,
    acknowledgeIndependentDifference: false,
    acknowledgeUnavailableIndependentPrice: true,
  };
  const evidence = {
    packetSha256: r.packetSha256,
    sourceSnapshotSha256: c.review.sourceSnapshotSha256,
    runtimeSha256: 'a'.repeat(64),
    minimumSlot: c.review.minimumSlot,
    maximumSlot: c.review.minimumSlot + 32,
    ownedContextUnchanged: true,
    custodyAndBalancesUnchanged: true,
    originalLifetimeValid: true,
    twoCompleteCodeScansMatched: true,
    trustedProgramPolicyEstablished: true,
    applicationReservationsChecked: true,
  };
  const original = {
    sourceSnapshotSha256: c.review.sourceSnapshotSha256,
    minimumSlot: c.review.minimumSlot,
  };
  return { v, r, consent, evidence, original };
}
it('starts the five-second clock at approval, rechecks before issuing, and expires without renewing', async () => {
  const { v, r, consent, evidence, original } = await setup();
  const start = v.clock.now;
  const recheck = vi.fn(async () => {
    v.clock.now += 1000;
    return evidence;
  });
  const auth = await authorizePairOrderAfterRecheck(
    r,
    consent,
    original,
    recheck,
    new AbortController().signal,
    () => v.clock.now,
  );
  expect(recheck).toHaveBeenCalledOnce();
  expect(Date.parse(auth.expiresAt)).toBe(start + 5000);
  await expect(
    requirePairOrderSigningWindow(auth, r, start + 4999),
  ).resolves.toBeUndefined();
  await expect(
    requirePairOrderSigningWindow(auth, r, start + 5000),
  ).rejects.toThrow(/new review/);
  await expect(
    requirePairOrderSigningWindow(
      { ...auth, minimumOutputRaw: '1' },
      r,
      start + 1001,
    ),
  ).rejects.toThrow();
  await expect(
    requirePairOrderSigningWindow(auth, r, start + 999),
  ).rejects.toThrow();
});
it.each([
  'custodyAndBalancesUnchanged',
  'originalLifetimeValid',
  'twoCompleteCodeScansMatched',
  'trustedProgramPolicyEstablished',
  'applicationReservationsChecked',
  'ownedContextUnchanged',
] as const)('requires fresh %s evidence', async (field) => {
  const { v, r, consent, evidence, original } = await setup();
  evidence[field] = false;
  await expect(
    authorizePairOrderAfterRecheck(
      r,
      consent,
      original,
      async () => evidence,
      new AbortController().signal,
      () => v.clock.now,
    ),
  ).rejects.toThrow(/new review/);
});
it.each([
  'slow',
  'backward',
  '33-slots',
  'balance-digest',
  'packet',
  'abort',
] as const)('refuses %s after rechecking', async (mode) => {
  const { v, r, consent, evidence, original } = await setup();
  const controller = new AbortController();
  await expect(
    authorizePairOrderAfterRecheck(
      r,
      consent,
      original,
      async () => {
        if (mode === 'slow') v.clock.now += 5000;
        if (mode === 'backward') v.clock.now--;
        if (mode === '33-slots') evidence.maximumSlot++;
        if (mode === 'balance-digest')
          evidence.sourceSnapshotSha256 = 'b'.repeat(64);
        if (mode === 'packet') evidence.packetSha256 = 'c'.repeat(64);
        if (mode === 'abort') controller.abort();
        return evidence;
      },
      controller.signal,
      () => v.clock.now,
    ),
  ).rejects.toThrow();
});
