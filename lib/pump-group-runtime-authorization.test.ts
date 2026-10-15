import { beforeAll, expect, it } from 'vitest';
import { pumpLaunchGroupReviewFixture } from '../test/pump-launch-group-review-fixture';
import { pumpRuntimePreviewFixture } from '../test/pump-runtime-preview-fixture';
import { pumpHolderDigest } from './pump-holder-review';
import { pumpGroupMatchesCurrentPrepare } from './pump-group-signing-scope';
import type { PumpGroupView } from './pump-launch-group-client';
import {
  groupSigningConsent,
  requirePumpCodeConsent,
  requirePumpRuntimePreview,
  requirePumpSigningAuthorization,
} from './pump-group-runtime-authorization';
let f: Awaited<ReturnType<typeof pumpLaunchGroupReviewFixture>>;
beforeAll(async () => {
  f = await pumpLaunchGroupReviewFixture();
}, 15000);
it('blocks a changed final wallet, limit, revision, project or public metadata origin before vault unlock', () => {
  const r = f.review;
  const view = { review: r } as PumpGroupView;
  const origin = new URL(r.input.create.uri).origin;
  const terms = {
    projectId: r.projectId,
    updatedAt: r.projectUpdatedAt,
    releaseId: r.releaseId,
    payer: r.input.create.payer,
    payerRevision: r.document.options.wallets!.deployer!.revision,
    mint: r.input.create.mint,
    feeAndRentLimitRaw: r.allowances.deployerFeeAndRentLimitRaw,
    ...(r.allowances.developerMaximumQuoteCostRaw === null
      ? {}
      : {
          developerMaximumQuoteCostRaw:
            r.allowances.developerMaximumQuoteCostRaw,
        }),
    holderLimits: r.allowances.holders.map((limit) => ({
      address: limit.address,
      feeAndRentLimitRaw: limit.feeAndRentLimitRaw,
      ...(limit.maximumQuoteCostRaw === null
        ? {}
        : { maximumQuoteCostRaw: limit.maximumQuoteCostRaw }),
      ...(limit.minimumTokenOutputRaw === null
        ? {}
        : { minimumTokenOutputRaw: limit.minimumTokenOutputRaw }),
    })),
  };
  expect(pumpGroupMatchesCurrentPrepare(view, terms, origin)).toBe(true);
  for (const patch of [
    { projectId: 'other' },
    { updatedAt: 'changed' },
    { payerRevision: 2 },
    { feeAndRentLimitRaw: '1' },
    { releaseId: 'f'.repeat(64) },
    { holderLimits: terms.holderLimits.slice(0, -1) },
    {
      holderLimits: terms.holderLimits.map((l, i) =>
        i === terms.holderLimits.length - 1
          ? { ...l, feeAndRentLimitRaw: '1' }
          : l,
      ),
    },
  ])
    expect(
      pumpGroupMatchesCurrentPrepare(view, { ...terms, ...patch }, origin),
    ).toBe(false);
  expect(
    pumpGroupMatchesCurrentPrepare(view, terms, 'https://other.test'),
  ).toBe(false);
});
it('binds every measured program and exact consent without treating code identity as an audit', async () => {
  const preview = await pumpRuntimePreviewFixture(f.review);
  expect(await requirePumpRuntimePreview(preview, f.review)).toEqual(preview);
  expect(groupSigningConsent(f.review)).toEqual(f.consent);
  const consent = {
    approved: true,
    previewId: preview.id,
    identitySha256: preview.identitySha256,
    acknowledgeUpgradeableCode: true,
    acknowledgeNoSemanticAudit: true,
  };
  expect(requirePumpCodeConsent(preview, consent)).toEqual(consent);
  for (const patch of [
    { approved: false },
    { acknowledgeUpgradeableCode: false },
    { acknowledgeNoSemanticAudit: false },
    { identitySha256: 'f'.repeat(64) },
    { previewId: crypto.randomUUID() },
    { executionAllowed: true },
  ])
    expect(() =>
      requirePumpCodeConsent(preview, { ...consent, ...patch }),
    ).toThrow();
  for (const patch of [
    { contextSha256: 'f'.repeat(64) },
    { signingAllowed: true },
    { semanticAuditEstablished: true },
    { expiresAt: new Date(Date.now() - 1).toISOString() },
  ])
    await expect(
      requirePumpRuntimePreview({ ...preview, ...patch }, f.review),
    ).rejects.toThrow();
  const subset = { ...preview, programs: preview.programs.slice(1) };
  subset.identitySha256 = await pumpHolderDigest({
    reviewId: f.review.id,
    contextSha256: f.review.contextSha256,
    programs: subset.programs,
  });
  await expect(requirePumpRuntimePreview(subset, f.review)).rejects.toThrow(
    'every group program',
  );
});
it('synchronously refuses expired, substituted or broadened signing authorization', async () => {
  const preview = await pumpRuntimePreviewFixture(f.review);
  const now = Date.now();
  const authorization = {
    format: 'pump-group-signing-authorization-v1',
    id: crypto.randomUUID(),
    reviewId: f.review.id,
    previewId: preview.id,
    contextSha256: f.review.contextSha256,
    manifestSha256: f.review.manifestSha256,
    simulationSha256: f.review.simulationSha256,
    identitySha256: preview.identitySha256,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 4000).toISOString(),
    scope: 'sign-complete-group-only',
    signingAllowed: true,
    executionAllowed: false,
    submissionAllowed: false,
    semanticAuditEstablished: false,
  };
  expect(
    requirePumpSigningAuthorization(authorization, preview, f.review),
  ).toEqual(authorization);
  for (const patch of [
    { expiresAt: new Date(now - 1).toISOString() },
    { expiresAt: new Date(now + 6000).toISOString() },
    { previewId: crypto.randomUUID() },
    { manifestSha256: 'f'.repeat(64) },
    { scope: 'sign-and-send' },
    { executionAllowed: true },
    { submissionAllowed: true },
    { semanticAuditEstablished: true },
  ])
    expect(() =>
      requirePumpSigningAuthorization(
        { ...authorization, ...patch },
        preview,
        f.review,
      ),
    ).toThrow();
});
