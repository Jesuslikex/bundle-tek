import { PumpPreflightError } from './owned-pump-preflight';
import { readPumpLaunchGroupReview } from './pump-launch-group-review-service';
import { collectOwnedPumpGroupObservation } from './pump-launch-group-observation-service';
import { pumpGroupTerminalCandidate } from './pump-launch-group-terminal';
import { canonicalPumpHolderJson } from './pump-holder-review';
import type { PumpLaunchRpc } from './pump-launch-simulation';

/** Collects its own finalized evidence and atomically closes only proved safe terminal cases. Never resends, signs or assumes economic settlement. */
export async function recoverOwnedPumpLaunchGroup(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
) {
  signal.throwIfAborted();
  const installed = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('pump_group_terminal_insert','pump_group_terminal_apply','pump_group_terminal_no_update','pump_group_terminal_no_delete')",
    )
    .first<{ n: number }>();
  if (installed?.n !== 4)
    throw new PumpPreflightError(
      'Terminal group recovery migration is not installed.',
      503,
    );
  const before = await readPumpLaunchGroupReview(db, owner, id);
  const broadcastTable = await db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='pump_group_broadcast_reviews'",
    )
    .first();
  if (
    broadcastTable &&
    (await db
      .prepare(
        'SELECT 1 FROM pump_group_broadcast_reviews WHERE owner_id=? AND review_id=?',
      )
      .bind(owner, id)
      .first())
  )
    throw new PumpPreflightError(
      'Recover this complete broadcast including its signed tip.',
      409,
    );
  if (['cancelled', 'failed'].includes(before.state) && before.receipt) {
    const closed = await db
      .prepare(
        'SELECT receipt FROM pump_group_terminal_recoveries WHERE owner_id=? AND review_id=?',
      )
      .bind(owner, id)
      .first<{ receipt: string }>();
    if (!closed || closed.receipt !== canonicalPumpHolderJson(before.receipt))
      throw new PumpPreflightError('Saved terminal group proof differs.', 409);
    return { group: before, observation: null, released: true };
  }
  if (!['approved', 'signed'].includes(before.state))
    throw new PumpPreflightError(
      'Recover an approved or signed complete group.',
      409,
    );
  const observation = await collectOwnedPumpGroupObservation(
    db,
    owner,
    id,
    signal,
    rpc,
  );
  signal.throwIfAborted();
  const receipt = await pumpGroupTerminalCandidate(before.review, observation);
  if (!receipt)
    return {
      group: await readPumpLaunchGroupReview(db, owner, id),
      observation,
      released: false,
    };
  const after = await readPumpLaunchGroupReview(db, owner, id);
  if (canonicalPumpHolderJson(after) !== canonicalPumpHolderJson(before))
    throw new PumpPreflightError(
      'Group changed before terminal recovery.',
      409,
    );
  signal.throwIfAborted();
  try {
    await db
      .prepare(
        'INSERT INTO pump_group_terminal_recoveries(review_id,owner_id,observation_id,receipt,created_at) VALUES(?,?,?,?,?)',
      )
      .bind(
        id,
        owner,
        observation.id,
        canonicalPumpHolderJson(receipt),
        new Date().toISOString(),
      )
      .run();
  } catch {
    throw new PumpPreflightError(
      'Fresh group recovery evidence changed before release. Reload saved history.',
      409,
    );
  }
  return {
    group: await readPumpLaunchGroupReview(db, owner, id),
    observation,
    released: true,
  };
}
