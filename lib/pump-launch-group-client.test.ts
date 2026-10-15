import { beforeAll, expect, it, vi } from 'vitest';
import { pumpLaunchGroupReviewFixture } from '../test/pump-launch-group-review-fixture';
import { signSyntheticPumpGroup } from '../test/pump-group-synthetic-signatures';
import {
  parsePumpGroupView,
  parsePumpGroupPage,
  parsePumpGroupObservation,
} from './pump-launch-group-client';
import { verifyPumpLaunchGroupSignatures } from './pump-launch-group-signatures';
import { observePumpLaunchGroupRecovery } from './pump-launch-group-recovery';
import { pumpHolderDigest } from './pump-holder-review';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
let f: Awaited<ReturnType<typeof pumpLaunchGroupReviewFixture>>;
let signed: Awaited<ReturnType<typeof verifyPumpLaunchGroupSignatures>>;
beforeAll(async () => {
  f = await pumpLaunchGroupReviewFixture();
  signed = await verifyPumpLaunchGroupSignatures(
    f.review,
    await signSyntheticPumpGroup(f.review.packets, [
      f.fixture.f.f.payerSigner,
      f.fixture.f.f.mintSigner,
      ...f.fixture.holderSigners,
    ]),
  );
}, 30000);
const response = (state = 'review') => ({
  format: 'pump-launch-group-review-v1',
  review: structuredClone(f.review),
  state,
  signedEvidence: state === 'signed' ? signed : null,
  durableReview: true,
  approvalRequired: !['approved', 'signed'].includes(state),
  signingAllowed: false,
  executionAllowed: false,
  completeLaunch: false,
  createdAt: '2026-10-15T00:00:00.000Z',
});
it('reconstructs every real fixture packet and preserves all wallet limits without granting execution', async () => {
  const checked = await parsePumpGroupView(response(), f.review.projectId);
  expect(checked.review).toEqual(f.review);
  expect(checked.review.packets.length).toBeGreaterThan(1);
  expect(checked.review.input.holders).toHaveLength(18);
  expect(checked.quoteDecimals).toBe(9);
  const retained = await parsePumpGroupView(
    response('signed'),
    f.review.projectId,
  );
  expect(retained.signedEvidence).toEqual(signed);
});
it.each([
  'foreign',
  'runtime',
  'subset',
  'reorder',
  'signers',
  'state',
  'signed-missing',
  'unregistered-signed',
] as const)('rejects %s group evidence', async (kind) => {
  const value = response();
  if (kind === 'foreign') value.review.projectId = 'other';
  if (kind === 'runtime') value.executionAllowed = true;
  if (kind === 'subset') value.review.packets.pop();
  if (kind === 'reorder') value.review.packets.reverse();
  if (kind === 'signers') value.review.packets[0].requiredSigners.pop();
  if (kind === 'state') value.state = 'finalized';
  if (kind === 'signed-missing') {
    value.state = 'signed';
    value.approvalRequired = false;
  }
  if (kind === 'unregistered-signed') value.signedEvidence = signed;
  await expect(parsePumpGroupView(value, f.review.projectId)).rejects.toThrow();
});
it('keeps expired reviews available for recovery but respects abort', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    parsePumpGroupView(response(), f.review.projectId, controller.signal),
  ).rejects.toThrow();
  // Reader deliberately uses requireLive=false; action services own live revalidation.
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120000);
  try {
    expect(
      (await parsePumpGroupView(response('cancelled'), f.review.projectId))
        .state,
    ).toBe('cancelled');
  } finally {
    clock.mockRestore();
  }
});
it('accepts only bounded, project-bound non-overlapping pages', () => {
  const page = parsePumpGroupPage(
    { launches: [response()], nextCursor: 'cursor1' },
    f.review.projectId,
  );
  expect(page.rows[0]).toMatchObject({
    id: f.review.id,
    createdAt: '2026-10-15T00:00:00.000Z',
  });
  for (const value of [
    { launches: [response(), response()], nextCursor: null },
    { launches: Array(21).fill(response()), nextCursor: null },
    { launches: [], nextCursor: 'cursor1' },
  ])
    expect(() => parsePumpGroupPage(value, f.review.projectId)).toThrow();
  expect(() =>
    parsePumpGroupPage(
      { launches: [response()], nextCursor: 'cursor1' },
      f.review.projectId,
      'cursor1',
    ),
  ).toThrow();
  expect(() =>
    parsePumpGroupPage({ launches: [response()], nextCursor: null }, 'foreign'),
  ).toThrow();
});
async function pendingObservation() {
  const observation = await observePumpLaunchGroupRecovery(
    f.review,
    null,
    new AbortController().signal,
    async (method) => {
      if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
      if (method === 'getEpochInfo')
        return {
          absoluteSlot: String(
            BigInt(f.review.input.create.lastValidBlockHeight) + 2000n,
          ),
          blockHeight: f.review.input.create.lastValidBlockHeight,
        };
      throw new Error('Unexpected provider method');
    },
  );
  return {
    id: crypto.randomUUID(),
    sourceState: 'approved',
    createdAt: observation.receipt.observedAt,
    sha256: await pumpHolderDigest(observation),
    ...observation,
  };
}
it('reads actual collector observations and refuses self-consistent but false counts, fees and release claims', async () => {
  const view = await parsePumpGroupView(
    response('approved'),
    f.review.projectId,
  );
  const observation = await pendingObservation();
  expect((await parsePumpGroupObservation(observation, view)).state).toBe(
    'pending',
  );
  for (const field of [
    'counts',
    'fees',
    'release',
    'foreign',
    'state',
  ] as const) {
    const bad = structuredClone(observation);
    if (field === 'counts') bad.receipt.observedPacketCount = 1;
    if (field === 'fees') bad.receipt.knownNetworkFeeRaw = '5';
    if (field === 'release')
      Object.assign(bad.receipt, { reservationsMustRemainHeld: false });
    if (field === 'foreign') bad.receipt.reviewId = crypto.randomUUID();
    if (field === 'state') Object.assign(bad, { state: 'complete' });
    bad.sha256 = await pumpHolderDigest({
      state: bad.state,
      receipt: bad.receipt,
    });
    await expect(parsePumpGroupObservation(bad, view)).rejects.toThrow();
  }
});
