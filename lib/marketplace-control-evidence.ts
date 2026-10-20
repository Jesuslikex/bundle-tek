import { z } from 'zod';
import { ownershipMessage } from './wallet-ownership-message';
import { operatorListingSelection } from './marketplace-operator-review';
import { operatorDraftCanonical } from './marketplace-operator-draft-view';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import {
  admitMarketplaceOwnedInventory,
  marketplaceOwnedInventoryResult,
  type MarketplaceOwnedInventory,
} from './marketplace-owned-inventory';

const id = z
  .string()
  .regex(/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i);
const time = z.iso.datetime().refine((v) => new Date(v).toISOString() === v);
const origin = z
  .string()
  .max(512)
  .refine((v) => {
    try {
      const url = new URL(v);
      return ['https:', 'http:'].includes(url.protocol) && url.origin === v;
    } catch {
      return false;
    }
  });
const challenge = z
  .object({
    origin,
    issuedAt: time,
    expiresAt: time,
    usedAt: time,
    messageSha256: z.string().regex(/^[a-f\d]{64}$/),
  })
  .strict();
const record = z
  .object({
    verifiedAt: time,
    challengeId: id,
    challenge: challenge.nullable(),
  })
  .strict();
export const marketplaceControlEvidence = z
  .object({
    format: z.literal('bundle-saved-control-evidence-v1'),
    chain: z.literal('Solana'),
    selection: operatorListingSelection,
    siteOrigin: origin,
    walletUpdatedAt: time,
    observedAt: time,
    expiresAt: time,
    state: z.enum([
      'no-record',
      'challenge-unavailable',
      'recent-record',
      'expired-record',
      'other-origin',
    ]),
    record: record.nullable(),
    recordedControlRecent: z.boolean(),
    evidenceType: z.literal('retained-server-verification-record'),
    signatureReplayed: z.literal(false),
    proofCoversWalletRevision: z.literal(false),
    proofCoversAskingPrice: z.literal(false),
    currentControlVerified: z.literal(false),
    exclusiveCustodyVerified: z.literal(false),
    publicationAllowed: z.literal(false),
    saleQualified: z.literal(false),
    paymentAllowed: z.literal(false),
    deliveryAllowed: z.literal(false),
    signingAllowed: z.literal(false),
  })
  .strict();
export type MarketplaceControlEvidence = z.infer<
  typeof marketplaceControlEvidence
>;
const joined = z
  .object({
    address:
      marketplaceOwnedInventoryResult.shape.wallets.element.shape.address,
    revision: z.number().int().min(1).max(1e9),
    walletUpdatedAt: time,
    proofVerifiedAt: time.nullable(),
    proofChallengeId: id.nullable(),
    challengeId: id.nullable(),
    message: z.string().max(2048).nullable(),
    challengeExpiresAt: time.nullable(),
    usedAt: time.nullable(),
    claimId: id.nullable(),
  })
  .strict();
const fail = (): never => {
  throw Error('Saved control evidence is unavailable or inconsistent.');
};
export class MarketplaceControlClockError extends Error {
  constructor() {
    super(
      'The control record snapshot expired or is ahead of this device clock. Check the device time, reload seller inventory and check the record again.',
    );
  }
}
function stateFor(
  value: MarketplaceControlEvidence['record'],
  site: string,
  at: number,
): MarketplaceControlEvidence['state'] {
  if (value === null) return 'no-record';
  if (value.challenge === null) return 'challenge-unavailable';
  if (Date.parse(value.challenge.expiresAt) <= at) return 'expired-record';
  return value.challenge.origin === site ? 'recent-record' : 'other-origin';
}
/** Reads trusted server verification records, not stored signatures. This cannot authorize a sale or signature. */
export async function buildMarketplaceControlEvidence(
  raw: unknown,
  input: unknown,
  site: string,
  now = Date.now(),
): Promise<MarketplaceControlEvidence> {
  const row = joined.parse(raw),
    selection = operatorListingSelection.parse(input),
    siteOrigin = origin.parse(site);
  if (
    !Number.isSafeInteger(now) ||
    row.address !== selection.address ||
    row.revision !== selection.walletRevision ||
    Date.parse(row.walletUpdatedAt) > now
  )
    return fail();
  const child = [
    row.challengeId,
    row.message,
    row.challengeExpiresAt,
    row.usedAt,
    row.claimId,
  ];
  let evidence: MarketplaceControlEvidence['record'] = null;
  if (row.proofVerifiedAt === null || row.proofChallengeId === null) {
    if (
      row.proofVerifiedAt !== null ||
      row.proofChallengeId !== null ||
      child.some((v) => v !== null)
    )
      return fail();
  } else {
    if (Date.parse(row.proofVerifiedAt) > now) return fail();
    if (row.challengeId === null) {
      if (child.some((v) => v !== null)) return fail();
      evidence = {
        verifiedAt: row.proofVerifiedAt,
        challengeId: row.proofChallengeId,
        challenge: null,
      };
    } else {
      if (
        child.some((v) => v === null) ||
        row.challengeId !== row.proofChallengeId ||
        row.usedAt !== row.proofVerifiedAt
      )
        return fail();
      const lines = row.message!.split('\n');
      if (
        lines.length !== 9 ||
        !lines[1].startsWith('Origin: ') ||
        !lines[6].startsWith('Issued: ')
      )
        return fail();
      const challengeOrigin = origin.parse(lines[1].slice(8)),
        issuedAt = time.parse(lines[6].slice(8));
      const issued = Date.parse(issuedAt),
        expires = Date.parse(row.challengeExpiresAt!),
        used = Date.parse(row.usedAt!);
      if (
        expires - issued !== 300000 ||
        used < issued ||
        used >= expires ||
        row.message !==
          ownershipMessage(
            challengeOrigin,
            'Solana',
            selection.address,
            row.challengeId,
            issuedAt,
            row.challengeExpiresAt!,
          )
      )
        return fail();
      evidence = {
        verifiedAt: row.proofVerifiedAt,
        challengeId: row.proofChallengeId,
        challenge: {
          origin: challengeOrigin,
          issuedAt,
          expiresAt: row.challengeExpiresAt!,
          usedAt: row.usedAt!,
          messageSha256: await digest(row.message!),
        },
      };
    }
  }
  const state = stateFor(evidence, siteOrigin, now),
    expires =
      state === 'recent-record'
        ? Math.min(now + 60000, Date.parse(evidence!.challenge!.expiresAt))
        : now + 60000;
  return marketplaceControlEvidence.parse({
    format: 'bundle-saved-control-evidence-v1',
    chain: 'Solana',
    selection,
    siteOrigin,
    walletUpdatedAt: row.walletUpdatedAt,
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(expires).toISOString(),
    state,
    record: evidence,
    recordedControlRecent: state === 'recent-record',
    evidenceType: 'retained-server-verification-record',
    signatureReplayed: false,
    proofCoversWalletRevision: false,
    proofCoversAskingPrice: false,
    currentControlVerified: false,
    exclusiveCustodyVerified: false,
    publicationAllowed: false,
    saleQualified: false,
    paymentAllowed: false,
    deliveryAllowed: false,
    signingAllowed: false,
  });
}

export async function admitMarketplaceControlEvidence(
  value: unknown,
  inventory: MarketplaceOwnedInventory,
  input: unknown,
  site: string,
  now = Date.now(),
) {
  const { evidence } = z
    .object({ evidence: marketplaceControlEvidence })
    .strict()
    .parse(value);
  const selection = operatorListingSelection.parse(input),
    siteOrigin = origin.parse(site);
  const wallet = admitMarketplaceOwnedInventory(inventory, now).wallets.find(
    (w) =>
      w.address === selection.address &&
      w.revision === selection.walletRevision,
  );
  const at = Date.parse(evidence.observedAt),
    expires = Date.parse(evidence.expiresAt);
  if (Number.isSafeInteger(now) && (at > now || now >= expires))
    throw new MarketplaceControlClockError();
  if (
    !wallet ||
    operatorDraftCanonical(evidence.selection) !==
      operatorDraftCanonical(selection) ||
    evidence.siteOrigin !== siteOrigin ||
    evidence.walletUpdatedAt !== wallet.updatedAt ||
    (evidence.record?.verifiedAt ?? null) !== wallet.ownershipProofAt ||
    at < Date.parse(inventory.observedAt) ||
    at > now ||
    now >= expires
  )
    return fail();
  const r = evidence.record,
    c = r?.challenge;
  if (r && Date.parse(r.verifiedAt) > at) return fail();
  if (c) {
    const issued = Date.parse(c.issuedAt),
      used = Date.parse(c.usedAt),
      until = Date.parse(c.expiresAt);
    if (
      c.usedAt !== r!.verifiedAt ||
      until - issued !== 300000 ||
      used < issued ||
      used >= until ||
      (await digest(
        ownershipMessage(
          c.origin,
          'Solana',
          selection.address,
          r!.challengeId,
          c.issuedAt,
          c.expiresAt,
        ),
      )) !== c.messageSha256
    )
      return fail();
  }
  const expected = stateFor(r, siteOrigin, at),
    expectedExpiry =
      expected === 'recent-record'
        ? Math.min(at + 60000, Date.parse(c!.expiresAt))
        : at + 60000;
  if (
    evidence.state !== expected ||
    evidence.recordedControlRecent !== (expected === 'recent-record') ||
    expires !== expectedExpiry
  )
    return fail();
  return evidence;
}
