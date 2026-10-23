import { z } from 'zod';
import {
  WARMUP_PROPOSAL_SCHEMA_SHA256,
  warmupProposalSqlTokens,
} from './wallet-warmup-execution-proposal-schema';
import { WARMUP_EXECUTION_APPROVAL_SCHEMA_SHA256 } from './wallet-warmup-execution-approval-schema';
import { WARMUP_PROPOSAL_STORAGE_POLICY } from './wallet-warmup-execution-proposal-storage';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import {
  warmupExecutionHash as hash,
  warmupExecutionId as uuid,
  warmupExecutionTimestamp as iso,
} from './wallet-warmup-execution-manifest';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';

export const WARMUP_EXECUTION_INVENTORY_PAGE = 25;
const ownerSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const cursorSchema = z.object({ createdAt: iso, id: uuid }).strict();
export class WarmupExecutionInventoryError extends Error {
  constructor(readonly status = 503) {
    super(
      status === 400
        ? 'Choose one original bounded history cursor.'
        : 'Warmup execution history or capacity is unavailable. No proposal, approval or execution was changed.',
    );
  }
}
function fail(): never {
  throw new WarmupExecutionInventoryError();
}
export function parseWarmupExecutionInventoryCursor(value: unknown) {
  if (value === undefined) return null;
  try {
    if (
      typeof value !== 'string' ||
      value.length > 256 ||
      !value ||
      !/^[A-Za-z0-9_-]+$/.test(value)
    )
      throw Error();
    const json = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    const cursor = cursorSchema.parse(JSON.parse(json));
    if (encodeCursor(cursor) !== value) throw Error();
    return cursor;
  } catch {
    throw new WarmupExecutionInventoryError(400);
  }
}
function encodeCursor(cursor: z.infer<typeof cursorSchema>) {
  return btoa(canonical(cursor))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
async function cancellable<T>(
  job: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    job
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', stop));
  });
}
async function installed(db: D1Database, signal: AbortSignal) {
  const expected = {
    ...WARMUP_PROPOSAL_SCHEMA_SHA256,
    ...WARMUP_EXECUTION_APPROVAL_SCHEMA_SHA256,
  };
  const names = Object.keys(expected);
  for (let start = 0; start < names.length; start += 50) {
    signal.throwIfAborted();
    const part = names.slice(start, start + 50);
    const rows = await cancellable(
      db
        .prepare(
          `SELECT name,sql FROM sqlite_master WHERE name IN (${part.map(() => '?').join(',')})`,
        )
        .bind(...part)
        .all<{ name: string; sql: string }>(),
      signal,
    );
    if (rows.success !== true || rows.results.length !== part.length) fail();
    for (const row of rows.results) {
      if (
        typeof row.sql !== 'string' ||
        !Object.hasOwn(expected, row.name) ||
        (await digest(warmupProposalSqlTokens(row.sql))) !== expected[row.name]
      )
        fail();
      signal.throwIfAborted();
    }
  }
  const fk = await cancellable(
    db.prepare('PRAGMA foreign_keys').first<{ foreign_keys: number }>(),
    signal,
  );
  if (fk?.foreign_keys !== 1) fail();
}
const int = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const rowSchema = z
  .object({
    id: uuid,
    consentId: uuid,
    reviewId: uuid,
    headerSha256: hash,
    requestSha256: hash,
    createdAt: iso,
    expiresAt: iso,
    evidenceCheckedAt: iso,
    declaredBytes: int,
    expectedChunks: int,
    storedChunks: int,
    storedBytes: int,
    invalidChunks: int,
    headerMismatch: int,
    linkMismatch: int,
    publishedAt: iso.nullable(),
    publicationHeader: hash.nullable(),
    approvedAt: iso.nullable(),
    rootCreatedAt: iso.nullable(),
    rootSha256: hash.nullable(),
    manifestSha256: hash.nullable(),
  })
  .strict();
const snapshotSchema = z
  .object({
    snapshotAt: iso,
    count: int,
    declaredBytes: int,
    rows: z.array(rowSchema).max(129),
  })
  .strict();
const SQL = `WITH selected AS (SELECT * FROM wallet_warmup_execution_proposal_stages WHERE owner_id=?1),
 bounded AS (SELECT * FROM selected ORDER BY created_at DESC,id DESC LIMIT 129),
 rows AS (SELECT json_object(
 'id',s.id,'consentId',s.consent_id,'reviewId',s.review_id,'headerSha256',s.header_sha256,'requestSha256',s.request_sha256,
 'createdAt',s.created_at,'expiresAt',s.expires_at,'evidenceCheckedAt',s.evidence_checked_at,'declaredBytes',s.byte_length,
 'expectedChunks',json_array_length(s.header,'$.chunks'),
 'headerMismatch',CASE WHEN json_extract(s.header,'$.id') IS NOT s.id OR json_extract(s.header,'$.ownerId') IS NOT s.owner_id OR json_extract(s.header,'$.consentId') IS NOT s.consent_id OR json_extract(s.header,'$.reviewId') IS NOT s.review_id OR json_extract(s.header,'$.bytes') IS NOT s.byte_length OR json_extract(s.header,'$.proposalExpiresAt') IS NOT s.expires_at THEN 1 ELSE 0 END,
 'storedChunks',(SELECT count(*) FROM wallet_warmup_execution_proposal_chunks c WHERE c.owner_id=s.owner_id AND c.proposal_id=s.id),
 'storedBytes',coalesce((SELECT sum(length(c.data)) FROM wallet_warmup_execution_proposal_chunks c WHERE c.owner_id=s.owner_id AND c.proposal_id=s.id),0),
 'invalidChunks',(SELECT count(*) FROM wallet_warmup_execution_proposal_chunks c WHERE c.owner_id=s.owner_id AND c.proposal_id=s.id AND (typeof(c.data)!='blob' OR json_extract(s.header,'$.chunks['||c.chunk_index||'].index') IS NOT c.chunk_index OR json_extract(s.header,'$.chunks['||c.chunk_index||'].bytes') IS NOT length(c.data) OR json_extract(s.header,'$.chunks['||c.chunk_index||'].sha256') IS NOT c.sha256)),
 'publishedAt',p.published_at,'publicationHeader',p.header_sha256,'approvedAt',a.approved_at,'rootCreatedAt',r.created_at,'rootSha256',r.root_sha256,'manifestSha256',r.manifest_sha256,
 'linkMismatch',CASE WHEN (a.proposal_id IS NOT NULL AND (p.proposal_id IS NULL OR a.consent_id IS NOT s.consent_id OR a.review_id IS NOT s.review_id OR a.header_sha256 IS NOT s.header_sha256 OR a.terms_sha256 IS NOT json_extract(s.header,'$.termsSha256'))) OR (r.proposal_id IS NOT NULL AND (a.proposal_id IS NULL OR r.consent_id IS NOT a.consent_id OR r.review_id IS NOT a.review_id OR r.header_sha256 IS NOT a.header_sha256 OR r.terms_sha256 IS NOT a.terms_sha256)) THEN 1 ELSE 0 END
 ) AS value FROM bounded s LEFT JOIN wallet_warmup_execution_proposal_publications p ON p.owner_id=s.owner_id AND p.proposal_id=s.id
 LEFT JOIN wallet_warmup_execution_approvals a ON a.owner_id=s.owner_id AND a.proposal_id=s.id LEFT JOIN wallet_warmup_execution_roots r ON r.owner_id=s.owner_id AND r.proposal_id=s.id)
 SELECT json_object('snapshotAt',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'count',(SELECT count(*) FROM selected),'declaredBytes',coalesce((SELECT sum(byte_length) FROM selected),0),'rows',json(coalesce((SELECT json_group_array(json(value)) FROM rows),'[]'))) AS document`;

/** SELECT-only metadata inventory. Schema fingerprints are checked, but proposal
 * BLOBs, their hashes and semantic evidence are NOT replayed. Counts/availability
 * describe one SQL snapshot, never a reservation, pruning or fresh approval.
 * Declared reservations include incomplete/expired history permanently under
 * today's schema. Stored BLOB bytes exclude SQLite/index/header/backup overhead.
 */
export async function readWarmupExecutionInventory(
  db: D1Database,
  owner: string,
  cursorValue: unknown,
  signal: AbortSignal,
) {
  const cursor = parseWarmupExecutionInventoryCursor(cursorValue);
  try {
    owner = ownerSchema.parse(owner);
    signal.throwIfAborted();
    await installed(db, signal);
    signal.throwIfAborted();
    const raw = await cancellable(
      db.prepare(SQL).bind(owner).first<{ document: string }>(),
      signal,
    );
    if (
      !raw ||
      typeof raw.document !== 'string' ||
      raw.document.length > 262144 ||
      new TextEncoder().encode(raw.document).length > 262144
    )
      fail();
    const snapshot = snapshotSchema.parse(JSON.parse(raw.document));
    if (
      snapshot.count !== snapshot.rows.length ||
      snapshot.count >
        WARMUP_PROPOSAL_STORAGE_POLICY.maximumProposalsPerOwner ||
      snapshot.declaredBytes >
        WARMUP_PROPOSAL_STORAGE_POLICY.maximumDeclaredBytesPerOwner
    )
      fail();
    const seen = new Set<string>();
    let bytes = 0,
      storedBytes = 0,
      storedChunks = 0;
    const rows = snapshot.rows.map((row) => {
      if (
        new Set([row.id, row.consentId, row.reviewId]).size !== 3 ||
        [row.id, row.consentId, row.reviewId].some((id) => seen.has(id)) ||
        row.invalidChunks ||
        row.headerMismatch ||
        row.linkMismatch ||
        row.declaredBytes < 1 ||
        row.declaredBytes > 67108864 ||
        row.expectedChunks !== Math.ceil(row.declaredBytes / 196608) ||
        row.storedChunks > row.expectedChunks ||
        row.storedBytes > row.declaredBytes ||
        row.storedBytes < row.storedChunks ||
        row.storedBytes > row.storedChunks * 196608 ||
        (row.storedChunks === row.expectedChunks &&
          row.storedBytes !== row.declaredBytes) ||
        (row.publishedAt === null) !== (row.publicationHeader === null) ||
        row.createdAt < row.evidenceCheckedAt ||
        row.createdAt >= row.expiresAt ||
        row.createdAt > snapshot.snapshotAt ||
        (row.publishedAt !== null &&
          (row.storedChunks !== row.expectedChunks ||
            row.storedBytes !== row.declaredBytes ||
            row.publicationHeader !== row.headerSha256 ||
            row.publishedAt < row.createdAt ||
            row.publishedAt >= row.expiresAt ||
            row.publishedAt > snapshot.snapshotAt)) ||
        (row.approvedAt !== null &&
          (row.publishedAt === null ||
            row.approvedAt < row.publishedAt ||
            row.approvedAt >= row.expiresAt ||
            row.approvedAt > snapshot.snapshotAt)) ||
        (row.rootCreatedAt !== null &&
          (row.approvedAt === null ||
            row.rootCreatedAt < row.approvedAt ||
            row.rootCreatedAt >= row.expiresAt ||
            row.rootCreatedAt > snapshot.snapshotAt)) ||
        (row.rootSha256 === null) !== (row.rootCreatedAt === null) ||
        (row.manifestSha256 === null) !== (row.rootCreatedAt === null)
      )
        fail();
      for (const id of [row.id, row.consentId, row.reviewId]) seen.add(id);
      bytes += row.declaredBytes;
      storedBytes += row.storedBytes;
      storedChunks += row.storedChunks;
      return {
        id: row.id,
        consentId: row.consentId,
        reviewId: row.reviewId,
        headerSha256: row.headerSha256,
        requestSha256: row.requestSha256,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        publishedAt: row.publishedAt,
        approvedAt: row.approvedAt,
        rootCreatedAt: row.rootCreatedAt,
        rootSha256: row.rootSha256,
        manifestSha256: row.manifestSha256,
        declaredBytes: row.declaredBytes,
        storedBytes: row.storedBytes,
        storedChunks: row.storedChunks,
        expectedChunks: row.expectedChunks,
        expired: snapshot.snapshotAt >= row.expiresAt,
        status:
          row.rootCreatedAt !== null
            ? ('root-recorded' as const)
            : row.approvedAt !== null
              ? ('approval-recorded' as const)
              : row.publishedAt !== null
                ? ('published' as const)
                : row.storedChunks === row.expectedChunks
                  ? ('staged' as const)
                  : ('incomplete' as const),
      };
    });
    if (bytes !== snapshot.declaredBytes) fail();
    // D1 disallows PRAGMA schema_version. Recheck the actual required schema
    // fingerprints/FK setting rather than weakening admission on that adapter.
    await installed(db, signal);
    signal.throwIfAborted();
    rows.sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id > b.id
          ? -1
          : a.id < b.id
            ? 1
            : 0
        : a.createdAt > b.createdAt
          ? -1
          : 1,
    );
    const remaining = rows.filter(
      (r) =>
        !cursor ||
        r.createdAt < cursor.createdAt ||
        (r.createdAt === cursor.createdAt && r.id < cursor.id),
    );
    const page = remaining.slice(0, WARMUP_EXECUTION_INVENTORY_PAGE),
      last = page.at(-1);
    return {
      format: 'wallet-warmup-execution-inventory-v1' as const,
      scope: 'owned-metadata-only-not-content-replayed' as const,
      snapshotAt: snapshot.snapshotAt,
      quota: {
        policy: 'lifetime-declared-reservations' as const,
        maximumProposals:
          WARMUP_PROPOSAL_STORAGE_POLICY.maximumProposalsPerOwner,
        maximumDeclaredBytes:
          WARMUP_PROPOSAL_STORAGE_POLICY.maximumDeclaredBytesPerOwner,
        proposals: snapshot.count,
        declaredBytes: bytes,
        remainingProposals:
          WARMUP_PROPOSAL_STORAGE_POLICY.maximumProposalsPerOwner -
          snapshot.count,
        remainingDeclaredBytes:
          WARMUP_PROPOSAL_STORAGE_POLICY.maximumDeclaredBytesPerOwner - bytes,
        storedChunkBytes: storedBytes,
        storedChunks,
        expiredNeverApproved: rows.filter(
          (r) => r.expired && r.approvedAt === null,
        ).length,
        incomplete: rows.filter((r) => r.status === 'incomplete').length,
        approved: rows.filter((r) => r.approvedAt !== null).length,
        roots: rows.filter((r) => r.rootCreatedAt !== null).length,
        capacityReserved: false as const,
        pruningSupported: false as const,
      },
      rows: page,
      nextCursor:
        remaining.length > page.length && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
      contentReplayed: false as const,
      receiptProvenanceVerified: false as const,
      currentSourceVerified: false as const,
      currentHeadVerified: false as const,
      financialReservationVerified: false as const,
      humanApprovalVerified: false as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
      automaticExecutionAllowed: false as const,
    };
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}
