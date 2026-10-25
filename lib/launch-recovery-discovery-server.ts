import {
  decodeLaunchRecoveryCursor,
  encodeLaunchRecoveryCursor,
  LAUNCH_RECOVERY_PAGE_LIMIT,
  validateLaunchRecoveryItem,
  validateLaunchRecoveryDiscovery,
  type LaunchRecoveryDiscovery,
} from './launch-recovery-discovery';
const projectName = `CASE WHEN json_valid(r.project_document) THEN CASE WHEN json_type(r.project_document,'$.plan.tokenName')='text' THEN json_extract(r.project_document,'$.plan.tokenName') ELSE NULL END ELSE NULL END`;
const pumpKind = `CASE WHEN json_valid(r.review) THEN CASE json_extract(r.review,'$.format') WHEN 'pump-launch-group-review-v1' THEN 'groups' WHEN 'pump-create-holders-review-v1' THEN 'holders' WHEN 'pump-create-buy-review-v1' THEN 'developer' ELSE CASE WHEN COALESCE(json_extract(r.review,'$.format'),'')='' AND json_valid(r.terms) THEN CASE WHEN json_extract(r.terms,'$.maximumQuoteCostRaw') IS NOT NULL THEN 'developer' ELSE 'create' END ELSE 'uncategorized' END END ELSE 'uncategorized' END`;
/** Scalar SELECT-only discovery. Never imports preparation, submission or provider services. */
export async function readLaunchRecoveryPage(
  db: D1Database,
  owner: string,
  cursor: string | null,
  signal: AbortSignal,
): Promise<LaunchRecoveryDiscovery> {
  if (typeof owner !== 'string' || !owner || owner.length > 256)
    throw Error('Owner required.');
  const before = decodeLaunchRecoveryCursor(cursor);
  signal.throwIfAborted();
  const columns = `r.id,r.project_id AS projectId,${projectName} AS projectName,r.mint,r.state,r.created_at AS createdAt,r.expires_at AS expiresAt,(r.signature IS NOT NULL) AS hasSignature,(r.receipt IS NOT NULL) AS hasReceipt`;
  const result = await db
    .prepare(`WITH candidates AS (
    SELECT 'pump' AS source,${pumpKind} AS reviewKind,${columns} FROM pump_launch_reviews r WHERE r.owner_id=? AND (r.state IS NULL OR r.state NOT IN ('finalized','failed','cancelled'))
    UNION ALL SELECT r.venue AS source,'single' AS reviewKind,${columns} FROM venue_launch_recoveries r WHERE r.owner_id=? AND (r.state IS NULL OR r.state NOT IN ('finalized','failed','cancelled'))
    UNION ALL SELECT r.venue AS source,'single' AS reviewKind,${columns} FROM launchlab_launch_recoveries r WHERE r.owner_id=? AND (r.state IS NULL OR r.state NOT IN ('finalized','failed','cancelled'))
  ) SELECT source,reviewKind,id,projectId,projectName,mint,state,createdAt,expiresAt,hasSignature,hasReceipt FROM candidates
  ${before ? 'WHERE createdAt<? OR (createdAt=? AND (source>? OR (source=? AND id<?)))' : ''}
  ORDER BY createdAt DESC,source ASC,id DESC LIMIT 21`)
    .bind(
      owner,
      owner,
      owner,
      ...(before
        ? [
            before.createdAt,
            before.createdAt,
            before.source,
            before.source,
            before.id,
          ]
        : []),
    )
    .all<Record<string, unknown>>();
  signal.throwIfAborted();
  if (
    !result.success ||
    !Array.isArray(result.results) ||
    result.results.length > LAUNCH_RECOVERY_PAGE_LIMIT + 1
  )
    throw Error('Incomplete recovery discovery.');
  const rows = result.results.map((row) => {
    if (
      ![0, 1].includes(row.hasSignature as number) ||
      ![0, 1].includes(row.hasReceipt as number)
    )
      throw Error('Invalid recorded evidence markers.');
    return validateLaunchRecoveryItem({
      ...row,
      projectName:
        typeof row.projectName === 'string' &&
        row.projectName.length > 0 &&
        row.projectName.length <= 128
          ? row.projectName
          : null,
      hasSignature: row.hasSignature === 1,
      hasReceipt: row.hasReceipt === 1,
    });
  });
  const items = rows.slice(0, LAUNCH_RECOVERY_PAGE_LIMIT);
  return validateLaunchRecoveryDiscovery(
    {
      format: 'launch-recovery-discovery-v1',
      scope: 'saved-solana-nonterminal',
      observedAt: new Date().toISOString(),
      cursor,
      nextCursor:
        rows.length > LAUNCH_RECOVERY_PAGE_LIMIT
          ? encodeLaunchRecoveryCursor(items.at(-1)!)
          : null,
      items,
      signingAllowed: false,
      executionAllowed: false,
      receiptVerified: false,
    },
    cursor,
  );
}
