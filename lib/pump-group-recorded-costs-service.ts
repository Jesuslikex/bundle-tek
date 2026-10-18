import { readPumpLaunchGroupReview } from './pump-launch-group-review-service';
import { readOwnedPumpGroupBroadcast } from './pump-group-broadcast-service';
import {
  parsePumpGroupView,
  parsePumpGroupObservation,
} from './pump-launch-group-client';
import { parsePumpGroupBroadcastState } from './pump-group-broadcast-client';
import { canonicalPumpHolderJson } from './pump-holder-review';
import { PumpPreflightError } from './owned-pump-preflight';
import { reconcilePumpGroupRecordedCosts } from './pump-group-recorded-costs';

/** Reads retained owner evidence only. No RPC, writes, release, signing or recovery action. */
export async function readOwnedPumpGroupRecordedCosts(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const before = await readPumpLaunchGroupReview(db, owner, id);
  const group = await parsePumpGroupView(
    before,
    before.review.projectId,
    signal,
  );
  if (group.receipt?.format !== 'pump-launch-group-broadcast-terminal-v1')
    throw new PumpPreflightError(
      'This group has no closed broadcast cost record yet. Review its saved launch recovery history.',
      409,
    );
  const rawBroadcast = await readOwnedPumpGroupBroadcast(db, owner, id);
  const broadcast = await parsePumpGroupBroadcastState(rawBroadcast, group);
  signal.throwIfAborted();
  if (!broadcast?.recovery || !broadcast.reservationsReleased)
    throw new PumpPreflightError(
      'Closed launch cost evidence is unavailable. No cost totals are shown.',
      409,
    );
  const source = await db
    .prepare(
      'SELECT id,context_sha256,manifest_sha256,signed_group_sha256,source_state,observed_state,observation,sha256,created_at FROM pump_group_observations WHERE owner_id=? AND review_id=? AND id=?',
    )
    .bind(owner, id, broadcast.recovery.groupObservationId)
    .first<{
      id: string;
      context_sha256: string;
      manifest_sha256: string;
      signed_group_sha256: string;
      source_state: string;
      observed_state: string;
      observation: string;
      sha256: string;
      created_at: string;
    }>();
  if (
    !source ||
    source.context_sha256 !== group.review.contextSha256 ||
    source.manifest_sha256 !== group.review.manifestSha256 ||
    source.signed_group_sha256 !== group.signedEvidence?.signedGroupSha256 ||
    source.source_state !== 'signed' ||
    source.sha256 !== broadcast.recovery.groupObservationSha256
  )
    throw new PumpPreflightError(
      'The exact retained launch observation is unavailable. No cost totals are shown.',
      409,
    );
  const core = JSON.parse(source.observation) as {
    state: unknown;
    receipt: unknown;
  };
  if (!core || core.state !== source.observed_state)
    throw new Error('Saved launch observation metadata differs.');
  const observation = await parsePumpGroupObservation(
    {
      ...core,
      id: source.id,
      sourceState: source.source_state,
      sha256: source.sha256,
      createdAt: source.created_at,
    },
    group,
  );
  const report = reconcilePumpGroupRecordedCosts(group, broadcast, observation);
  signal.throwIfAborted();
  const after = await readPumpLaunchGroupReview(db, owner, id);
  signal.throwIfAborted();
  if (canonicalPumpHolderJson(before) !== canonicalPumpHolderJson(after))
    throw new PumpPreflightError(
      'Saved launch changed while checking recorded costs. Reload its history.',
      409,
    );
  return report;
}
