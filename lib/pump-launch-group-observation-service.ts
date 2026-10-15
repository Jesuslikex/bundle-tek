import { PumpPreflightError } from './owned-pump-preflight';
import {
  requirePumpLaunchGroupReview,
  requirePumpLaunchGroupConsent,
  type PumpLaunchGroupConsent,
} from './pump-launch-group-review';
import {
  canonicalPumpHolderJson,
  pumpHolderDigest,
} from './pump-holder-review';
import { observePumpLaunchGroupRecovery } from './pump-launch-group-recovery';
import type { PumpLaunchRpc } from './pump-launch-simulation';

type Row = {
  id: string;
  owner_id: string;
  review: string;
  state: string;
  signed: string | null;
  signature: string | null;
};
type Observation = Awaited<ReturnType<typeof observePumpLaunchGroupRecovery>>;
type Stored = {
  id: string;
  owner_id: string;
  review_id: string;
  context_sha256: string;
  manifest_sha256: string;
  signed_group_sha256: string | null;
  source_state: string;
  observed_state: string;
  sha256: string;
  observation: string;
  created_at: string;
};
export type PumpGroupObservationPosition = {
  reviewId: string;
  createdAt: string;
  id: string;
};
const fail = (message: string, status = 409): never => {
  throw new PumpPreflightError(message, status);
};
const FORMAT = 'pump-launch-group-review-v1';
async function guards(db: D1Database) {
  const result = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('pump_group_observation_insert','pump_group_observation_no_update','pump_group_observation_no_delete')",
    )
    .first<{ n: number }>();
  if (result?.n !== 3)
    fail(
      'Group observation migration is not installed. Recovery storage remains disabled.',
      503,
    );
}
async function parent(db: D1Database, owner: string, id: string) {
  const row = await db
    .prepare(
      "SELECT id,owner_id,review,state,signed,signature FROM pump_launch_reviews WHERE owner_id=? AND id=? AND json_extract(review,'$.format')=?",
    )
    .bind(owner, id, FORMAT)
    .first<Row>();
  if (!row) return fail('Owned complete-group review not found.', 404);
  const { review } = await requirePumpLaunchGroupReview(
    JSON.parse(row.review),
    false,
  );
  return { row, review };
}
async function convert(
  stored: Stored,
  review: Awaited<ReturnType<typeof parent>>['review'],
) {
  const observation = JSON.parse(stored.observation) as Observation;
  if (
    stored.review_id !== review.id ||
    stored.context_sha256 !== review.contextSha256 ||
    stored.manifest_sha256 !== review.manifestSha256 ||
    observation.receipt?.format !==
      'pump-launch-group-recovery-observation-v1' ||
    observation.state !== stored.observed_state ||
    observation.receipt.reviewId !== review.id ||
    observation.receipt.contextSha256 !== review.contextSha256 ||
    observation.receipt.manifestSha256 !== review.manifestSha256 ||
    observation.receipt.signedGroupSha256 !== stored.signed_group_sha256 ||
    observation.receipt.observedAt !== stored.created_at ||
    (await pumpHolderDigest(observation)) !== stored.sha256 ||
    observation.receipt.reservationsMustRemainHeld !== true ||
    observation.receipt.completeLaunch !== false ||
    observation.receipt.executionAllowed !== false ||
    observation.receipt.signingAllowed !== false
  )
    return fail('Saved group recovery observation differs.');
  return {
    id: stored.id,
    sourceState: stored.source_state,
    sha256: stored.sha256,
    createdAt: stored.created_at,
    ...observation,
  };
}

/** Owner must come from the authenticated session. Collects observations itself; no caller-authored receipt or state transition is accepted. */
export async function collectOwnedPumpGroupObservation(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  signal.throwIfAborted();
  await guards(db);
  const { row, review } = await parent(db, owner, id);
  if (!['approved', 'signed'].includes(row.state))
    return fail(
      'Recorded group approval is required before recovery observation.',
    );
  const approval = await db
    .prepare(
      'SELECT consent,context_sha256,manifest_sha256 FROM pump_group_approvals WHERE owner_id=? AND review_id=?',
    )
    .bind(owner, id)
    .first<{
      consent: string;
      context_sha256: string;
      manifest_sha256: string;
    }>();
  if (
    !approval ||
    approval.context_sha256 !== review.contextSha256 ||
    approval.manifest_sha256 !== review.manifestSha256
  )
    return fail('Saved complete-group approval differs.');
  const consent = JSON.parse(approval.consent) as PumpLaunchGroupConsent;
  requirePumpLaunchGroupConsent(review, consent);
  if (canonicalPumpHolderJson(consent) !== approval.consent)
    return fail('Saved group consent encoding differs.');
  const signed = row.signed
    ? (JSON.parse(row.signed) as Parameters<
        typeof observePumpLaunchGroupRecovery
      >[1])
    : null;
  if (
    row.state === 'approved'
      ? row.signed !== null || row.signature !== null
      : !signed || !row.signature
  )
    return fail('Saved group signing state differs.');
  if (signed) {
    const registered = await db
      .prepare(
        'SELECT signed,signature,signed_group_sha256 FROM pump_group_signatures WHERE owner_id=? AND review_id=?',
      )
      .bind(owner, id)
      .first<{
        signed: string;
        signature: string;
        signed_group_sha256: string;
      }>();
    if (
      !registered ||
      registered.signed !== row.signed ||
      registered.signature !== row.signature ||
      registered.signed_group_sha256 !== signed.signedGroupSha256
    )
      return fail('Saved complete-group signature registration differs.');
  }
  signal.throwIfAborted();
  const observation = await observePumpLaunchGroupRecovery(
    review,
    signed,
    signal,
    rpc,
  );
  signal.throwIfAborted();
  const current = await parent(db, owner, id);
  if (
    current.row.review !== row.review ||
    current.row.state !== row.state ||
    current.row.signed !== row.signed ||
    current.row.signature !== row.signature
  )
    return fail(
      'Group state changed during recovery observation. Reload its history.',
    );
  const stored: Stored = {
    id: crypto.randomUUID(),
    owner_id: owner,
    review_id: id,
    context_sha256: review.contextSha256,
    manifest_sha256: review.manifestSha256,
    signed_group_sha256: signed?.signedGroupSha256 ?? null,
    source_state: row.state,
    observed_state: observation.state,
    sha256: await pumpHolderDigest(observation),
    observation: canonicalPumpHolderJson(observation),
    created_at: observation.receipt.observedAt,
  };
  signal.throwIfAborted();
  try {
    await db
      .prepare(
        'INSERT INTO pump_group_observations(id,owner_id,review_id,context_sha256,manifest_sha256,signed_group_sha256,source_state,observed_state,sha256,observation,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        stored.id,
        owner,
        id,
        stored.context_sha256,
        stored.manifest_sha256,
        stored.signed_group_sha256,
        stored.source_state,
        stored.observed_state,
        stored.sha256,
        stored.observation,
        stored.created_at,
      )
      .run();
  } catch {
    return fail(
      'Group approval, signing state or observation scope changed before storage. Reload its history.',
    );
  }
  return convert(stored, review);
}

/** A cursor is a position only. Every page binds both authenticated owner and exact immutable review. */
export async function listOwnedPumpGroupObservations(
  db: D1Database,
  owner: string,
  id: string,
  before: PumpGroupObservationPosition | null = null,
) {
  await guards(db);
  const { review } = await parent(db, owner, id);
  if (
    before &&
    (Object.keys(before).sort().join(',') !== 'createdAt,id,reviewId' ||
      before.reviewId !== id ||
      !/^[a-f0-9-]{36}$/.test(before.id) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(before.createdAt) ||
      !Number.isFinite(Date.parse(before.createdAt)) ||
      new Date(before.createdAt).toISOString() !== before.createdAt)
  )
    return fail('Invalid group observation history position.', 400);
  const { results } = await db
    .prepare(`SELECT * FROM pump_group_observations WHERE owner_id=? AND review_id=?
    ${before ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT 21`)
    .bind(
      owner,
      id,
      ...(before ? [before.createdAt, before.createdAt, before.id] : []),
    )
    .all<Stored>();
  const visible = results.slice(0, 20),
    last = visible.at(-1);
  return {
    observations: await Promise.all(visible.map((row) => convert(row, review))),
    nextPosition:
      results.length > 20 && last
        ? { reviewId: id, createdAt: last.created_at, id: last.id }
        : null,
  };
}
