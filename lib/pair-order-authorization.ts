import { pairRuntimeDigest } from './pair-runtime-trace';
import {
  requirePairOrderFirstConsent,
  type PairOrderFirstConsent,
  type PairOrderFirstReview,
} from './pair-order-first-review';

export type PairOrderSigningRecheck = {
  packetSha256: string;
  sourceSnapshotSha256: string;
  runtimeSha256: string;
  minimumSlot: number;
  maximumSlot: number;
  ownedContextUnchanged: boolean;
  custodyAndBalancesUnchanged: boolean;
  originalLifetimeValid: boolean;
  twoCompleteCodeScansMatched: boolean;
  trustedProgramPolicyEstablished: boolean;
  applicationReservationsChecked: boolean;
};
export type PairOrderSigningAuthorization = Awaited<
  ReturnType<typeof authorizePairOrderAfterRecheck>
>;

/** Internal contract only. Production calls this only behind the disabled release gate. */
export async function authorizePairOrderAfterRecheck(
  review: PairOrderFirstReview,
  consent: PairOrderFirstConsent,
  original: { sourceSnapshotSha256: string; minimumSlot: number },
  recheck: () => Promise<PairOrderSigningRecheck>,
  signal: AbortSignal,
  now: () => number = Date.now,
  approvedAt = now(),
) {
  await requirePairOrderFirstConsent(review, consent, approvedAt);
  signal.throwIfAborted();
  const fresh = await recheck();
  signal.throwIfAborted();
  const completedAt = now(),
    expires = Math.min(approvedAt + 5000, Date.parse(review.expiresAt));
  const hash = (s: string) => /^[a-f0-9]{64}$/.test(s);
  if (
    !Number.isFinite(completedAt) ||
    completedAt < approvedAt ||
    completedAt >= expires ||
    fresh.packetSha256 !== review.packetSha256 ||
    !hash(fresh.runtimeSha256) ||
    !hash(fresh.sourceSnapshotSha256) ||
    fresh.sourceSnapshotSha256 !== original.sourceSnapshotSha256 ||
    !Number.isSafeInteger(fresh.minimumSlot) ||
    !Number.isSafeInteger(fresh.maximumSlot) ||
    fresh.minimumSlot < original.minimumSlot ||
    fresh.maximumSlot < fresh.minimumSlot ||
    fresh.maximumSlot - original.minimumSlot > 32 ||
    fresh.ownedContextUnchanged !== true ||
    fresh.custodyAndBalancesUnchanged !== true ||
    fresh.originalLifetimeValid !== true ||
    fresh.twoCompleteCodeScansMatched !== true ||
    fresh.trustedProgramPolicyEstablished !== true ||
    fresh.applicationReservationsChecked !== true
  )
    throw Error(
      'Fresh lifetime, ownership, custody, balances or code qualification failed. Request a new review.',
    );
  const terms = {
    format: 'pair-order-signing-authorization-v1' as const,
    id: crypto.randomUUID(),
    reviewSha256: review.sha256,
    packetSha256: review.packetSha256,
    minimumOutputRaw: review.minimumOutputRaw,
    runtimeSha256: fresh.runtimeSha256,
    sourceSnapshotSha256: fresh.sourceSnapshotSha256,
    consent,
    createdAt: new Date(approvedAt).toISOString(),
    recheckedAt: new Date(completedAt).toISOString(),
    expiresAt: new Date(expires).toISOString(),
    scope: 'sign-exact-reviewed-packet-only' as const,
    signingAllowed: true as const,
    executionAllowed: false as const,
    submissionAllowed: false as const,
  };
  return { ...terms, sha256: await pairRuntimeDigest(terms) };
}

/** Browser must run immediately before any future local signer; never auto-renews. */
export async function requirePairOrderSigningWindow(
  auth: PairOrderSigningAuthorization,
  review: PairOrderFirstReview,
  now: number,
) {
  const { sha256, ...terms } = auth;
  await requirePairOrderFirstConsent(review, auth.consent, now);
  const start = Date.parse(auth.createdAt),
    rechecked = Date.parse(auth.recheckedAt),
    end = Date.parse(auth.expiresAt);
  if (
    (await pairRuntimeDigest(terms)) !== sha256 ||
    auth.reviewSha256 !== review.sha256 ||
    auth.packetSha256 !== review.packetSha256 ||
    auth.minimumOutputRaw !== review.minimumOutputRaw ||
    auth.scope !== 'sign-exact-reviewed-packet-only' ||
    auth.signingAllowed !== true ||
    auth.executionAllowed !== false ||
    auth.submissionAllowed !== false ||
    !Number.isFinite(start) ||
    !Number.isFinite(rechecked) ||
    !Number.isFinite(end) ||
    rechecked < start ||
    end > start + 5000 ||
    end > Date.parse(review.expiresAt) ||
    !Number.isFinite(now) ||
    now < rechecked ||
    now >= end
  )
    throw Error(
      'Signing authorization expired or changed. Request a new review.',
    );
}
