/** Compatible with schemas before source-only session bindings were introduced. */
export async function isSessionBoundWarmupPreparation(
  db: D1Database,
  owner: string,
  preparationId: string,
) {
  const table = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='wallet_warmup_session_action_bindings'",
    )
    .first();
  if (
    table &&
    Boolean(
      await db
        .prepare(
          'SELECT 1 FROM wallet_warmup_session_action_bindings WHERE owner_id=? AND preparation_id=?',
        )
        .bind(owner, preparationId)
        .first(),
    )
  )
    return true;
  const versioned = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='wallet_warmup_session_v2_attempts'",
    )
    .first();
  return versioned
    ? Boolean(
        await db
          .prepare(
            'SELECT 1 FROM wallet_warmup_session_v2_attempts WHERE owner_id=? AND id=?',
          )
          .bind(owner, preparationId)
          .first(),
      )
    : false;
}
export const SESSION_PREPARATION_SIGNING_DISABLED =
  'Session-bound signing is not enabled';
