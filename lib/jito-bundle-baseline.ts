export async function jitoBaselinePending(db: D1Database, owner: string) {
  return Boolean(
    await db
      .prepare(
        'SELECT b.id FROM jito_bundles b WHERE b.owner_id=? AND NOT EXISTS(SELECT 1 FROM jito_bundle_events e WHERE e.owner_id=b.owner_id AND e.bundle_id=b.id) LIMIT 1',
      )
      .bind(owner)
      .first(),
  );
}
export async function recordJitoBaselines(db: D1Database, owner: string) {
  // A bounded, user-invoked data backfill outside schema migrations. The
  // INSERT/SELECT captures current state atomically and skips any bundle
  // already carrying a review, transition, or earlier baseline event.
  const result = await db
    .prepare(
      "INSERT INTO jito_bundle_events(id,owner_id,bundle_id,project_id,session_id,type,packet,document,created_at) SELECT lower(hex(randomblob(16))),p.owner_id,p.id,p.project_id,p.session_id,'bundle.baseline',NULL,p.document,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM jito_bundle_activity_projection p WHERE p.owner_id=? AND NOT EXISTS(SELECT 1 FROM jito_bundle_events e WHERE e.owner_id=p.owner_id AND e.bundle_id=p.id) ORDER BY p.id LIMIT 50",
    )
    .bind(owner)
    .run();
  const created = result.meta.changes;
  if (!Number.isSafeInteger(created) || created < 0 || created > 50)
    throw new Error('Baseline progress unavailable.');
  return { created, baselinePending: await jitoBaselinePending(db, owner) };
}
