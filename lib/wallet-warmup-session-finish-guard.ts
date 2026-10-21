const guards = {
  review: 'wallet_warmup_session_review_finish',
  binding: 'wallet_warmup_session_binding_finish',
  packet: 'wallet_warmup_session_packet_finish',
} as const;
/** New writes need the database-clock finish guard; historical reads stay available. */
export async function walletWarmupSessionFinishGuardInstalled(
  db: D1Database,
  scope: keyof typeof guards,
) {
  return !!(await db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='trigger' AND name=?",
    )
    .bind(guards[scope])
    .first());
}
