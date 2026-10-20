import { expect, it } from 'vitest';
import { marketplaceControlFixture } from '../test/marketplace-control-evidence-fixture';
import {
  buildMarketplaceControlEvidence,
  admitMarketplaceControlEvidence,
} from './marketplace-control-evidence';
import { ownershipMessage } from './wallet-ownership-message';
const now = Date.parse('2026-10-20T12:00:00.000Z');
it('classifies an exact recent server record without claiming signature replay, exclusive custody or price/revision consent', async () => {
  const f = marketplaceControlFixture(now),
    evidence = await buildMarketplaceControlEvidence(
      f.row,
      f.selection,
      f.site,
      now,
    );
  expect(evidence).toMatchObject({
    state: 'recent-record',
    recordedControlRecent: true,
    signatureReplayed: false,
    currentControlVerified: false,
    exclusiveCustodyVerified: false,
    proofCoversWalletRevision: false,
    proofCoversAskingPrice: false,
    publicationAllowed: false,
    saleQualified: false,
    paymentAllowed: false,
    deliveryAllowed: false,
    signingAllowed: false,
  });
  expect(evidence.expiresAt).toBe(new Date(now + 60000).toISOString());
  expect(evidence.record?.challenge?.issuedAt).toBe(f.issuedAt);
  expect(evidence.record).not.toHaveProperty('claimId');
  expect(evidence.record).not.toHaveProperty('signature');
  expect(
    await admitMarketplaceControlEvidence(
      { evidence },
      f.inventory,
      f.selection,
      f.site,
      now,
    ),
  ).toEqual(evidence);
});
it('distinguishes no saved proof from a saved proof whose original challenge is unavailable', async () => {
  const f = marketplaceControlFixture(now);
  Object.assign(f.row, {
    challengeId: null,
    message: null,
    challengeExpiresAt: null,
    usedAt: null,
    claimId: null,
  });
  expect(
    await buildMarketplaceControlEvidence(f.row, f.selection, f.site, now),
  ).toMatchObject({
    state: 'challenge-unavailable',
    recordedControlRecent: false,
    record: { verifiedAt: f.verifiedAt, challengeId: f.id, challenge: null },
  });
  Object.assign(f.row, { proofVerifiedAt: null, proofChallengeId: null });
  expect(
    await buildMarketplaceControlEvidence(f.row, f.selection, f.site, now),
  ).toMatchObject({
    state: 'no-record',
    record: null,
    recordedControlRecent: false,
  });
});
it('keeps the original issued-to-expiry window and never refreshes it from the later verification time', async () => {
  const f = marketplaceControlFixture(now);
  f.row.challengeExpiresAt = new Date(now + 1).toISOString();
  const issued = new Date(now - 299999).toISOString();
  f.row.message = ownershipMessage(
    f.site,
    'Solana',
    f.selection.address,
    f.id,
    issued,
    f.row.challengeExpiresAt,
  );
  const recent = await buildMarketplaceControlEvidence(
    f.row,
    f.selection,
    f.site,
    now,
  );
  expect(recent.expiresAt).toBe(f.row.challengeExpiresAt);
  await expect(
    admitMarketplaceControlEvidence(
      { evidence: recent },
      f.inventory,
      f.selection,
      f.site,
      now + 1,
    ),
  ).rejects.toThrow();
  expect(
    await buildMarketplaceControlEvidence(f.row, f.selection, f.site, now + 1),
  ).toMatchObject({ state: 'expired-record', recordedControlRecent: false });
});
it('reports another canonical origin as a non-recent record without granting same-site control', async () => {
  const f = marketplaceControlFixture(now);
  f.row.message = ownershipMessage(
    'https://old-bundle.test',
    'Solana',
    f.selection.address,
    f.id,
    f.issuedAt,
    f.expiresAt,
  );
  const evidence = await buildMarketplaceControlEvidence(
    f.row,
    f.selection,
    f.site,
    now,
  );
  expect(evidence.state).toBe('other-origin');
  expect(evidence.recordedControlRecent).toBe(false);
  expect(
    await admitMarketplaceControlEvidence(
      { evidence },
      f.inventory,
      f.selection,
      f.site,
      now,
    ),
  ).toEqual(evidence);
});
it.each([
  'revision',
  'address',
  'proof-time',
  'used-time',
  'challenge-id',
  'missing-claim',
  'partial-proof',
  'partial-child',
  'purpose',
  'network',
  'message-address',
  'message-nonce',
  'expiry-window',
  'origin-path',
  'extra-line',
])(
  'refuses inconsistent %s rather than reporting recent ownership',
  async (change) => {
    const f = marketplaceControlFixture(now);
    if (change === 'revision') f.row.revision++;
    if (change === 'address') f.row.address = f.source.b;
    if (change === 'proof-time')
      f.row.proofVerifiedAt = new Date(now + 1).toISOString();
    if (change === 'used-time') f.row.usedAt = f.issuedAt;
    if (change === 'challenge-id')
      f.row.challengeId = '33333333-3333-4333-8333-333333333333';
    if (change === 'missing-claim') f.row.claimId = null;
    if (change === 'partial-proof') f.row.proofVerifiedAt = null;
    if (change === 'partial-child') f.row.message = null;
    if (change === 'purpose')
      f.row.message = f.row.message!.replace(
        'record ownership',
        'approve selling',
      );
    if (change === 'network')
      f.row.message = f.row.message!.replace(
        'Network: Solana',
        'Network: Base',
      );
    if (change === 'message-address')
      f.row.message = f.row.message!.replace(f.source.a, f.source.b);
    if (change === 'message-nonce')
      f.row.message = f.row.message!.replace(
        f.id,
        '33333333-3333-4333-8333-333333333333',
      );
    if (change === 'expiry-window')
      f.row.challengeExpiresAt = new Date(now + 240001).toISOString();
    if (change === 'origin-path')
      f.row.message = f.row.message!.replace(f.site, f.site + '/path');
    if (change === 'extra-line') f.row.message += '\nAuthorize a payment';
    await expect(
      buildMarketplaceControlEvidence(f.row, f.selection, f.site, now),
    ).rejects.toThrow();
  },
);
it.each([
  'state',
  'recent-flag',
  'signature-flag',
  'consent-flag',
  'price',
  'site',
  'wallet-time',
  'record-time',
  'challenge-hash',
  'lifetime',
  'future',
  'authority',
])('client refuses altered %s evidence', async (change) => {
  const f = marketplaceControlFixture(now),
    evidence = await buildMarketplaceControlEvidence(
      f.row,
      f.selection,
      f.site,
      now,
    );
  if (change === 'state') evidence.state = 'expired-record';
  if (change === 'recent-flag') evidence.recordedControlRecent = false;
  if (change === 'signature-flag')
    Object.assign(evidence, { signatureReplayed: true });
  if (change === 'consent-flag')
    Object.assign(evidence, { proofCoversAskingPrice: true });
  if (change === 'price') evidence.selection.priceLamports = '1';
  if (change === 'site') evidence.siteOrigin = 'https://other.test';
  if (change === 'wallet-time')
    evidence.walletUpdatedAt = new Date(now - 1).toISOString();
  if (change === 'record-time') evidence.record!.verifiedAt = f.issuedAt;
  if (change === 'challenge-hash')
    evidence.record!.challenge!.messageSha256 = 'a'.repeat(64);
  if (change === 'lifetime')
    evidence.expiresAt = new Date(now + 60001).toISOString();
  if (change === 'future')
    evidence.observedAt = new Date(now + 1).toISOString();
  if (change === 'authority') Object.assign(evidence, { paymentAllowed: true });
  await expect(
    admitMarketplaceControlEvidence(
      { evidence },
      f.inventory,
      f.selection,
      f.site,
      now,
    ),
  ).rejects.toThrow();
});
it('client refuses changed proof sources, expired data and extra response fields', async () => {
  const f = marketplaceControlFixture(now),
    evidence = await buildMarketplaceControlEvidence(
      f.row,
      f.selection,
      f.site,
      now,
    );
  const changed = structuredClone(f.inventory);
  changed.wallets[0].ownershipProofAt = null;
  await expect(
    admitMarketplaceControlEvidence(
      { evidence },
      changed,
      f.selection,
      f.site,
      now,
    ),
  ).rejects.toThrow();
  await expect(
    admitMarketplaceControlEvidence(
      { evidence },
      f.inventory,
      f.selection,
      f.site,
      now + 60000,
    ),
  ).rejects.toThrow();
  await expect(
    admitMarketplaceControlEvidence(
      { evidence, approved: true },
      f.inventory,
      f.selection,
      f.site,
      now,
    ),
  ).rejects.toThrow();
});
