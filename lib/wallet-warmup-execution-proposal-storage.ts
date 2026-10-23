import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import {
  warmupExecutionId as uuid,
  warmupExecutionHash as hash,
  warmupExecutionTimestamp as iso,
} from './wallet-warmup-execution-manifest';
import {
  reviewWarmupExecutionBudget,
  reconstructWarmupExecutionProposal,
  warmupExecutionBudgetRequestSchema,
} from './wallet-warmup-execution-budget-review';
import { WARMUP_EXECUTION_SOURCE_CURRENT_SQL } from './wallet-warmup-execution-source';
import {
  WARMUP_PROPOSAL_SOURCE_SQL_SHA256,
  WARMUP_PROPOSAL_SCHEMA_SHA256,
  warmupProposalSqlTokens,
} from './wallet-warmup-execution-proposal-schema';
import {
  packWarmupExecutionProposal,
  unpackWarmupExecutionProposal,
  parseWarmupExecutionProposalHeader,
  type WarmupProposalChunk,
} from './wallet-warmup-execution-proposal-codec';

/** Declared input-byte reservations include incomplete/expired records. No
 * silent pruning, renewal or quota bypass; retention management is not mounted. */
export const WARMUP_PROPOSAL_STORAGE_POLICY = Object.freeze({
  maximumProposalsPerOwner: 128,
  maximumDeclaredBytesPerOwner: 268435456,
  maximumHeaderBytes: 131072,
});
const ownerSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const stageSchema = z
  .object({
    owner_id: ownerSchema,
    id: uuid,
    consent_id: uuid,
    review_id: uuid,
    review_sha256: hash,
    source_snapshot_sha256: hash,
    request_sha256: hash,
    header: z.string().max(WARMUP_PROPOSAL_STORAGE_POLICY.maximumHeaderBytes),
    header_sha256: hash,
    byte_length: z.number().int().positive().max(67108864),
    evidence_checked_at: iso,
    expires_at: iso,
    created_at: iso,
  })
  .strict();
const publicationSchema = z
  .object({ header_sha256: hash, published_at: iso })
  .strict();
const flags = {
  humanApprovalVerified: false as const,
  currentSourceVerified: false as const,
  networkVerified: false as const,
  signingAllowed: false as const,
  executionAllowed: false as const,
  automaticExecutionAllowed: false as const,
};
const names = Object.keys(WARMUP_PROPOSAL_SCHEMA_SHA256);
export class WarmupProposalStorageError extends Error {
  constructor() {
    super(
      'Warmup proposal is unavailable, incomplete or changed. Recover the same proposal ID.',
    );
    this.name = 'WarmupProposalStorageError';
  }
}
function fail(): never {
  throw new WarmupProposalStorageError();
}
async function installed(db: D1Database, signal: AbortSignal) {
  signal.throwIfAborted();
  const rows = await db
    .prepare(
      `SELECT name,sql FROM sqlite_master WHERE name IN (${names.map(() => '?').join(',')})`,
    )
    .bind(...names)
    .all<{ name: string; sql: string }>();
  const fk = await db
    .prepare('PRAGMA foreign_keys')
    .first<{ foreign_keys: number }>();
  signal.throwIfAborted();
  if (
    !rows.success ||
    rows.results.length !== names.length ||
    fk?.foreign_keys !== 1 ||
    (await digest(
      warmupProposalSqlTokens(WARMUP_EXECUTION_SOURCE_CURRENT_SQL),
    )) !== WARMUP_PROPOSAL_SOURCE_SQL_SHA256
  )
    fail();
  for (const row of rows.results) {
    signal.throwIfAborted();
    if (
      !Object.hasOwn(WARMUP_PROPOSAL_SCHEMA_SHA256, row.name) ||
      typeof row.sql !== 'string' ||
      (await digest(warmupProposalSqlTokens(row.sql))) !==
        WARMUP_PROPOSAL_SCHEMA_SHA256[row.name]
    )
      fail();
  }
}
async function stage(db: D1Database, owner: string, id: string) {
  const row = await db
    .prepare(`SELECT owner_id,id,consent_id,review_id,review_sha256,source_snapshot_sha256,
    request_sha256,header,header_sha256,byte_length,evidence_checked_at,expires_at,created_at
    FROM wallet_warmup_execution_proposal_stages WHERE owner_id=? AND id=?`)
    .bind(owner, id)
    .first();
  return row === null ? null : stageSchema.parse(row);
}
async function publication(db: D1Database, owner: string, id: string) {
  const row = await db
    .prepare(
      'SELECT header_sha256,published_at FROM wallet_warmup_execution_proposal_publications WHERE owner_id=? AND proposal_id=?',
    )
    .bind(owner, id)
    .first();
  return row === null ? null : publicationSchema.parse(row);
}
function blob(value: unknown, length: number) {
  if (value instanceof ArrayBuffer) {
    if (value.byteLength !== length) fail();
    return new Uint8Array(value);
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength !== length) fail();
    return new Uint8Array(value);
  }
  if (
    Array.isArray(value) &&
    value.length === length &&
    value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
  )
    return Uint8Array.from(value);
  return fail();
}

/** Saved-only owned lookup; no fallback to latest, provider call, clock refresh,
 * inferred approval or write. Publication is advisory metadata, never a root. */
export async function readWarmupExecutionProposal(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  try {
    owner = ownerSchema.parse(owner);
    id = uuid.parse(id);
    await installed(db, signal);
    const before = await stage(db, owner, id);
    if (!before) return null;
    const pub = await publication(db, owner, id);
    if (
      new TextEncoder().encode(before.header).length >
      WARMUP_PROPOSAL_STORAGE_POLICY.maximumHeaderBytes
    )
      fail();
    const h = parseWarmupExecutionProposalHeader(JSON.parse(before.header));
    if (
      canonical(h) !== before.header ||
      (await digest(before.header)) !== before.header_sha256 ||
      h.id !== id ||
      h.ownerId !== owner ||
      h.consentId !== before.consent_id ||
      h.reviewId !== before.review_id ||
      h.bytes !== before.byte_length ||
      h.proposalExpiresAt !== before.expires_at ||
      before.created_at >= before.expires_at ||
      before.created_at < before.evidence_checked_at ||
      (pub &&
        (pub.header_sha256 !== before.header_sha256 ||
          pub.published_at < before.created_at ||
          pub.published_at >= before.expires_at))
    )
      fail();
    const rows = await db
      .prepare(
        'SELECT chunk_index,length(data) AS byte_length,sha256 FROM wallet_warmup_execution_proposal_chunks WHERE owner_id=? AND proposal_id=? ORDER BY chunk_index',
      )
      .bind(owner, id)
      .all<{ chunk_index: number; byte_length: number; sha256: string }>();
    signal.throwIfAborted();
    if (
      !rows.success ||
      rows.results.length > h.chunks.length ||
      rows.results.some(
        (r) =>
          !Number.isInteger(r.chunk_index) ||
          !h.chunks[r.chunk_index] ||
          h.chunks[r.chunk_index].bytes !== r.byte_length ||
          h.chunks[r.chunk_index].sha256 !== r.sha256,
      )
    )
      fail();
    const common = {
      id,
      consentId: before.consent_id,
      reviewId: before.review_id,
      headerSha256: before.header_sha256,
      requestSha256: before.request_sha256,
      createdAt: before.created_at,
      proposalExpiresAt: before.expires_at,
      publishedAt: pub?.published_at ?? null,
      stagedChunks: rows.results.length,
      totalChunks: h.chunks.length,
      ...flags,
    };
    if (rows.results.length !== h.chunks.length) {
      if (pub) fail();
      if (
        canonical(await stage(db, owner, id)) !== canonical(before) ||
        (await publication(db, owner, id))
      )
        fail();
      return {
        ...common,
        status: 'incomplete' as const,
        message:
          'Original proposal bytes are incomplete. No approval is available. Recover this same ID to check saved progress; recovery never fetches replacement evidence.',
      };
    }
    const chunks: WarmupProposalChunk[] = [];
    for (const c of h.chunks) {
      signal.throwIfAborted();
      const row = await db
        .prepare(
          'SELECT data FROM wallet_warmup_execution_proposal_chunks WHERE owner_id=? AND proposal_id=? AND chunk_index=?',
        )
        .bind(owner, id, c.index)
        .first<{ data: unknown }>();
      if (!row) fail();
      chunks.push({ index: c.index, data: blob(row.data, c.bytes) });
    }
    const decoded = await unpackWarmupExecutionProposal(
      h,
      chunks,
      {
        id,
        ownerId: owner,
        consentId: before.consent_id,
        reviewId: before.review_id,
        headerSha256: before.header_sha256,
      },
      signal,
    );
    const replay = await reconstructWarmupExecutionProposal(
      db,
      owner,
      { terms: decoded.terms, verifierEvidence: decoded.verifierEvidence },
      {
        id,
        consentId: before.consent_id,
        reviewId: before.review_id,
        termsSha256: h.termsSha256,
      },
      signal,
    );
    const request = warmupExecutionBudgetRequestSchema.parse({
      reviewId: replay.terms.review.id,
      reviewSha256: replay.terms.review.sha256,
      rootId: id,
      consentId: replay.terms.intent.consentId,
      sessionExpiresAt: replay.terms.intent.expiresAt,
      feeRentLimits: replay.terms.intent.actions.map((a) => ({
        actionId: a.id,
        maximumLamports: a.maximumFeeRentLamports,
      })),
    });
    if (
      replay.verifierEvidence.assets.checkedAt !== before.evidence_checked_at ||
      replay.sourceSnapshotSha256 !== before.source_snapshot_sha256 ||
      replay.terms.review.sha256 !== before.review_sha256 ||
      (await digest(canonical(request))) !== before.request_sha256 ||
      canonical(await stage(db, owner, id)) !== canonical(before) ||
      canonical(await publication(db, owner, id)) !== canonical(pub)
    )
      fail();
    signal.throwIfAborted();
    return {
      ...common,
      status: pub ? ('published' as const) : ('staged' as const),
      proposal: replay,
    };
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}

async function publish(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  // Fingerprint-verified BEFORE INSERT triggers repeat the exact shared
  // mutable-source predicate and SQL clock inside this same atomic statement.
  // Immutable chunks were completely decoded/reconstructed immediately before
  // this call; the trigger also requires every descriptor-sized piece.
  const result = await db
    .prepare(`INSERT INTO wallet_warmup_execution_proposal_publications(owner_id,proposal_id,header_sha256,published_at)
    SELECT p.owner_id,p.id,p.header_sha256,strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM wallet_warmup_execution_proposal_stages p JOIN wallet_warmup_session_reviews r ON r.owner_id=p.owner_id AND r.id=p.review_id
    WHERE p.owner_id=? AND p.id=? AND r.review_sha256=p.review_sha256
    AND strftime('%Y-%m-%dT%H:%M:%fZ','now')>=p.created_at
    AND strftime('%Y-%m-%dT%H:%M:%fZ','now')<p.expires_at`)
    .bind(owner, id)
    .run();
  if (!result.success || result.meta.changes !== 1) fail();
  signal.throwIfAborted();
}

/** Private metadata writer. Owner must be authenticated by the future caller.
 * Accepts proposed IDs/limits only; the real fresh-budget service collects and
 * derives evidence internally. Same-ID recovery never recollects or renews.
 * No HTTP/approval/signing caller is mounted by this module. */
export async function retainWarmupExecutionProposal(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
) {
  try {
    owner = ownerSchema.parse(owner);
    const request = warmupExecutionBudgetRequestSchema.parse(value);
    const requestSha256 = await digest(canonical(request));
    signal.throwIfAborted();
    await installed(db, signal);
    const prior = await readWarmupExecutionProposal(
      db,
      owner,
      request.rootId,
      signal,
    );
    if (prior) {
      if (prior.requestSha256 !== requestSha256) fail();
      if (prior.status === 'staged') {
        const raced = await publishOrRecover(db, owner, prior, signal);
        if (raced) return raced;
        return await readWarmupExecutionProposal(db, owner, prior.id, signal);
      }
      return prior;
    }
    const identities = [request.rootId, request.consentId, request.reviewId];
    const conflict = await db
      .prepare(`SELECT 1 AS present FROM wallet_warmup_execution_proposal_stages WHERE owner_id=?
      AND (id IN (?,?,?) OR consent_id IN (?,?,?) OR review_id IN (?,?,?)) LIMIT 1`)
      .bind(owner, ...identities, ...identities, ...identities)
      .first();
    if (conflict) fail();
    for (const table of [
      'wallet_warmup_session_consents',
      'wallet_warmup_session_consents_v2',
    ]) {
      if (
        await db
          .prepare(
            `SELECT 1 AS present FROM ${table} WHERE owner_id=? AND (id IN (?,?,?) OR review_id IN (?,?,?)) LIMIT 1`,
          )
          .bind(owner, ...identities, ...identities)
          .first()
      )
        fail();
    }
    const quota = await db
      .prepare(
        'SELECT count(*) AS n,coalesce(sum(byte_length),0) AS bytes FROM wallet_warmup_execution_proposal_stages WHERE owner_id=?',
      )
      .bind(owner)
      .first<{ n: number; bytes: number }>();
    if (
      !quota ||
      !Number.isSafeInteger(quota.n) ||
      !Number.isSafeInteger(quota.bytes) ||
      quota.n >= WARMUP_PROPOSAL_STORAGE_POLICY.maximumProposalsPerOwner ||
      quota.bytes >= WARMUP_PROPOSAL_STORAGE_POLICY.maximumDeclaredBytesPerOwner
    )
      fail();
    signal.throwIfAborted();
    const fresh = await reviewWarmupExecutionBudget(db, owner, request, signal);
    const packed = await packWarmupExecutionProposal(
      {
        format: 'wallet-warmup-execution-proposal-content-v1',
        terms: fresh.terms,
        verifierEvidence: fresh.verifierEvidence,
      },
      signal,
    );
    signal.throwIfAborted();
    const result = await db
      .prepare(`INSERT INTO wallet_warmup_execution_proposal_stages(owner_id,id,consent_id,review_id,review_sha256,
      source_snapshot_sha256,request_sha256,header,header_sha256,byte_length,evidence_checked_at,expires_at,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM wallet_warmup_session_reviews r
      WHERE r.owner_id=? AND r.id=? AND r.review_sha256=?`)
      .bind(
        owner,
        request.rootId,
        request.consentId,
        request.reviewId,
        request.reviewSha256,
        fresh.budget.sourceSnapshotSha256,
        requestSha256,
        canonical(packed.header),
        packed.headerSha256,
        packed.header.bytes,
        fresh.verifierEvidence.assets.checkedAt,
        packed.header.proposalExpiresAt,
        owner,
        request.reviewId,
        request.reviewSha256,
      )
      .run();
    if (!result.success || result.meta.changes !== 1) fail();
    for (const c of packed.chunks) {
      signal.throwIfAborted();
      const inserted = await db
        .prepare(
          'INSERT INTO wallet_warmup_execution_proposal_chunks(owner_id,proposal_id,chunk_index,data,sha256) VALUES(?,?,?,?,?)',
        )
        .bind(
          owner,
          request.rootId,
          c.index,
          c.data.buffer,
          packed.header.chunks[c.index].sha256,
        )
        .run();
      if (!inserted.success || inserted.meta.changes !== 1) fail();
    }
    const kept = await readWarmupExecutionProposal(
      db,
      owner,
      request.rootId,
      signal,
    );
    if (
      !kept ||
      kept.headerSha256 !== packed.headerSha256 ||
      kept.requestSha256 !== requestSha256
    )
      fail();
    if (kept.status === 'published') return kept;
    if (kept.status !== 'staged') fail();
    const raced = await publishOrRecover(db, owner, kept, signal);
    if (raced) return raced;
    const saved = await readWarmupExecutionProposal(db, owner, kept.id, signal);
    if (
      !saved ||
      saved.status !== 'published' ||
      saved.headerSha256 !== packed.headerSha256
    )
      fail();
    return saved;
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}

async function publishOrRecover(
  db: D1Database,
  owner: string,
  original: { id: string; requestSha256: string; headerSha256: string },
  signal: AbortSignal,
) {
  try {
    await publish(db, owner, original.id, signal);
  } catch (error) {
    signal.throwIfAborted();
    const raced = await readWarmupExecutionProposal(
      db,
      owner,
      original.id,
      signal,
    );
    if (
      raced?.status === 'published' &&
      raced.requestSha256 === original.requestSha256 &&
      raced.headerSha256 === original.headerSha256
    )
      return raced;
    throw error;
  }
  return null;
}
