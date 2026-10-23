import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import {
  warmupExecutionId as uuid,
  warmupExecutionHash as hash,
  warmupExecutionTimestamp as iso,
  WARMUP_EXECUTION_POLICY,
} from './wallet-warmup-execution-manifest';
import {
  bindWarmupExecutionRoot,
  WARMUP_EXECUTION_ACKNOWLEDGEMENT,
} from './wallet-warmup-execution-terms';
import { reviewWalletWarmupExecutionPacing } from './wallet-warmup-execution-pacing';
import { readWarmupExecutionProposal } from './wallet-warmup-execution-proposal-storage';
import { warmupProposalSqlTokens } from './wallet-warmup-execution-proposal-schema';
import { WARMUP_EXECUTION_APPROVAL_SCHEMA_SHA256 } from './wallet-warmup-execution-approval-schema';

const ownerSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const warmupExecutionApprovalRequestSchema = z
  .object({
    proposalId: uuid,
    headerSha256: hash,
    termsSha256: hash,
    approved: z.literal(true),
    acknowledgement: z.literal(WARMUP_EXECUTION_ACKNOWLEDGEMENT),
  })
  .strict();
const approvalSchema = z
  .object({
    owner_id: ownerSchema,
    proposal_id: uuid,
    consent_id: uuid,
    review_id: uuid,
    header_sha256: hash,
    terms_sha256: hash,
    request_sha256: hash,
    approved_at: iso,
    session_expires_at: iso,
    pacing_before: iso,
    acknowledgement: z.literal(WARMUP_EXECUTION_ACKNOWLEDGEMENT),
  })
  .strict();
const rootSchema = z
  .object({
    owner_id: ownerSchema,
    proposal_id: uuid,
    consent_id: uuid,
    review_id: uuid,
    header_sha256: hash,
    terms_sha256: hash,
    consent_sha256: hash,
    root_sha256: hash,
    manifest_sha256: hash,
    created_at: iso,
  })
  .strict();
const flags = {
  ownerApprovalRecorded: true as const,
  humanApprovalVerified: false as const,
  currentSourceVerified: false as const,
  signingAllowed: false as const,
  executionAllowed: false as const,
  automaticExecutionAllowed: false as const,
};
export class WarmupExecutionApprovalError extends Error {
  constructor() {
    super(
      'Exact warmup approval is unavailable or changed. Recover the same proposal ID.',
    );
    this.name = 'WarmupExecutionApprovalError';
  }
}
function fail(): never {
  throw new WarmupExecutionApprovalError();
}
/** An immutable child was appended between saved-only snapshots. No provider
 * retry or clock refresh is permitted; writers may repeat this read once. */
export class WarmupExecutionApprovalReadRace extends WarmupExecutionApprovalError {
  constructor() {
    super();
    this.name = 'WarmupExecutionApprovalReadRace';
  }
}

async function installed(db: D1Database, signal: AbortSignal) {
  const names = Object.keys(WARMUP_EXECUTION_APPROVAL_SCHEMA_SHA256);
  const result = await db
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
    !result.success ||
    result.results.length !== names.length ||
    fk?.foreign_keys !== 1
  )
    fail();
  for (const r of result.results) {
    signal.throwIfAborted();
    if (
      !Object.hasOwn(WARMUP_EXECUTION_APPROVAL_SCHEMA_SHA256, r.name) ||
      typeof r.sql !== 'string' ||
      (await digest(warmupProposalSqlTokens(r.sql))) !==
        WARMUP_EXECUTION_APPROVAL_SCHEMA_SHA256[r.name]
    )
      fail();
  }
}
async function approval(db: D1Database, owner: string, id: string) {
  const row = await db
    .prepare(`SELECT owner_id,proposal_id,consent_id,review_id,header_sha256,terms_sha256,request_sha256,
    approved_at,session_expires_at,pacing_before,acknowledgement FROM wallet_warmup_execution_approvals WHERE owner_id=? AND proposal_id=?`)
    .bind(owner, id)
    .first();
  return row === null ? null : approvalSchema.parse(row);
}
async function root(db: D1Database, owner: string, id: string) {
  const row = await db
    .prepare(`SELECT owner_id,proposal_id,consent_id,review_id,header_sha256,terms_sha256,consent_sha256,
    root_sha256,manifest_sha256,created_at FROM wallet_warmup_execution_roots WHERE owner_id=? AND proposal_id=?`)
    .bind(owner, id)
    .first();
  return row === null ? null : rootSchema.parse(row);
}

/** Exact exclusive bound for this necessary lower-bound model. It is NOT an
 * execution estimate or authorization. Only verified original terms may enter. */
export function warmupExecutionApprovalPacingBefore(
  terms: Awaited<ReturnType<typeof bindWarmupExecutionRoot>>['root']['terms'],
) {
  const selected = {
    actions: terms.intent.actions.map(({ id, scheduledAt }) => ({
      id,
      scheduledAt,
    })),
    sessionExpiresAt: terms.intent.expiresAt,
  };
  const bound =
    Date.parse(selected.sessionExpiresAt) -
    (selected.actions.length - 1) * WARMUP_EXECUTION_POLICY.minimumGapMs;
  if (
    !Number.isSafeInteger(bound) ||
    bound <= 0 ||
    !reviewWalletWarmupExecutionPacing(selected, bound - 1).fitsMinimumPacing ||
    reviewWalletWarmupExecutionPacing(selected, bound).fitsMinimumPacing
  )
    fail();
  return new Date(bound).toISOString();
}

/** Private saved-only recovery. Never obtains new evidence, checks today's
 * clock, publishes a missing root or upgrades old consent. Authority stays off. */
async function readApprovalSnapshot(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  try {
    owner = ownerSchema.parse(owner);
    id = uuid.parse(id);
    signal.throwIfAborted();
    await installed(db, signal);
    const before = await approval(db, owner, id),
      keptRoot = await root(db, owner, id);
    if (!before) {
      if (keptRoot) throw new WarmupExecutionApprovalReadRace();
      return null;
    }
    if (before.owner_id !== owner || before.proposal_id !== id) fail();
    const saved = await readWarmupExecutionProposal(db, owner, id, signal);
    if (
      !saved ||
      saved.status !== 'published' ||
      saved.headerSha256 !== before.header_sha256 ||
      saved.proposal.termsSha256 !== before.terms_sha256 ||
      saved.consentId !== before.consent_id ||
      saved.reviewId !== before.review_id ||
      before.approved_at < saved.publishedAt! ||
      before.approved_at >= saved.proposalExpiresAt ||
      before.pacing_before !==
        warmupExecutionApprovalPacingBefore(saved.proposal.terms) ||
      before.approved_at >= before.pacing_before ||
      before.session_expires_at !== saved.proposal.terms.intent.expiresAt
    )
      fail();
    const request = warmupExecutionApprovalRequestSchema.parse({
      proposalId: id,
      headerSha256: before.header_sha256,
      termsSha256: before.terms_sha256,
      approved: true,
      acknowledgement: before.acknowledgement,
    });
    if ((await digest(canonical(request))) !== before.request_sha256) fail();
    const bound = await bindWarmupExecutionRoot(saved.proposal.terms, {
      format: 'wallet-warmup-execution-approval-v1',
      id: before.consent_id,
      rootId: id,
      ownerId: owner,
      reviewId: before.review_id,
      termsSha256: before.terms_sha256,
      approvedAt: before.approved_at,
      sessionExpiresAt: before.session_expires_at,
      acknowledgement: before.acknowledgement,
    });
    if (
      keptRoot &&
      (keptRoot.owner_id !== owner ||
        keptRoot.proposal_id !== id ||
        keptRoot.consent_id !== before.consent_id ||
        keptRoot.review_id !== before.review_id ||
        keptRoot.header_sha256 !== before.header_sha256 ||
        keptRoot.terms_sha256 !== before.terms_sha256 ||
        keptRoot.consent_sha256 !== bound.root.consentSha256 ||
        keptRoot.root_sha256 !== bound.rootSha256 ||
        keptRoot.manifest_sha256 !== bound.manifestSha256 ||
        keptRoot.created_at < before.approved_at ||
        keptRoot.created_at >= saved.proposalExpiresAt ||
        keptRoot.created_at >= before.pacing_before)
    )
      fail();
    if (
      canonical(await approval(db, owner, id)) !== canonical(before) ||
      canonical(await root(db, owner, id)) !== canonical(keptRoot)
    )
      throw new WarmupExecutionApprovalReadRace();
    signal.throwIfAborted();
    const result = {
      proposalId: id,
      consentId: before.consent_id,
      reviewId: before.review_id,
      headerSha256: before.header_sha256,
      termsSha256: before.terms_sha256,
      requestSha256: before.request_sha256,
      approval: bound.approval,
      consentSha256: bound.root.consentSha256,
      proposalExpiresAt: saved.proposalExpiresAt,
      pacingBefore: before.pacing_before,
      status: keptRoot
        ? ('root-recorded' as const)
        : ('approval-recorded' as const),
      root: keptRoot ? bound.root : null,
      rootSha256: keptRoot ? bound.rootSha256 : null,
      manifestSha256: keptRoot ? bound.manifestSha256 : null,
      rootCreatedAt: keptRoot?.created_at ?? null,
      scope: 'exact-owner-request-metadata-only' as const,
      ...flags,
    };
    return { result, bound };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof WarmupExecutionApprovalReadRace) throw error;
    return fail();
  }
}

async function publishRoot(
  db: D1Database,
  owner: string,
  snapshot: NonNullable<Awaited<ReturnType<typeof readApprovalSnapshot>>>,
  signal: AbortSignal,
  reread: { remaining: number },
) {
  const { result: kept, bound } = snapshot;
  const id = kept.proposalId;
  if (kept.status === 'root-recorded') return kept;
  signal.throwIfAborted();
  try {
    const inserted = await db
      .prepare(`INSERT INTO wallet_warmup_execution_roots(owner_id,proposal_id,consent_id,review_id,header_sha256,
      terms_sha256,consent_sha256,root_sha256,manifest_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .bind(
        owner,
        id,
        kept.consentId,
        kept.reviewId,
        kept.headerSha256,
        kept.termsSha256,
        kept.consentSha256,
        bound.rootSha256,
        bound.manifestSha256,
      )
      .run();
    if (!inserted.success || inserted.meta.changes !== 1) fail();
  } catch (error) {
    signal.throwIfAborted();
    const raced = await readStableApproval(db, owner, id, signal, reread);
    if (
      raced?.result.status === 'root-recorded' &&
      raced.result.requestSha256 === kept.requestSha256 &&
      raced.result.rootSha256 === bound.rootSha256
    )
      return raced.result;
    throw error;
  }
  signal.throwIfAborted();
  const result = await readStableApproval(db, owner, id, signal, reread);
  if (
    !result ||
    result.result.status !== 'root-recorded' ||
    result.result.rootSha256 !== bound.rootSha256
  )
    fail();
  return result.result;
}

/** Metadata-only exact approval. Future HTTP caller must independently verify
 * the owner session, origin and explicit unchecked consent. No injected clock,
 * provider, opaque evidence or timestamp. No signing/execution caller mounted. */
export async function retainWarmupExecutionApproval(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
) {
  try {
    owner = ownerSchema.parse(owner);
    const request = warmupExecutionApprovalRequestSchema.parse(value);
    const requestSha256 = await digest(canonical(request));
    signal.throwIfAborted();
    await installed(db, signal);
    const reread = { remaining: 1 };
    const prior = await readStableApproval(
      db,
      owner,
      request.proposalId,
      signal,
      reread,
    );
    if (prior) {
      if (prior.result.requestSha256 !== requestSha256) fail();
      return prior.result.status === 'root-recorded'
        ? prior.result
        : await publishRoot(db, owner, prior, signal, reread);
    }
    const saved = await readWarmupExecutionProposal(
      db,
      owner,
      request.proposalId,
      signal,
    );
    if (
      !saved ||
      saved.status !== 'published' ||
      saved.headerSha256 !== request.headerSha256 ||
      saved.proposal.termsSha256 !== request.termsSha256
    )
      fail();
    const pacingBefore = warmupExecutionApprovalPacingBefore(
      saved.proposal.terms,
    );
    signal.throwIfAborted();
    try {
      const inserted = await db
        .prepare(`INSERT INTO wallet_warmup_execution_approvals(owner_id,proposal_id,consent_id,review_id,header_sha256,
        terms_sha256,request_sha256,approved_at,session_expires_at,pacing_before,acknowledgement)
        VALUES(?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,?,?)`)
        .bind(
          owner,
          request.proposalId,
          saved.consentId,
          saved.reviewId,
          request.headerSha256,
          request.termsSha256,
          requestSha256,
          saved.proposal.terms.intent.expiresAt,
          pacingBefore,
          request.acknowledgement,
        )
        .run();
      if (!inserted.success || inserted.meta.changes !== 1) fail();
    } catch (error) {
      signal.throwIfAborted();
      const raced = await readStableApproval(
        db,
        owner,
        request.proposalId,
        signal,
        reread,
      );
      if (!raced || raced.result.requestSha256 !== requestSha256) throw error;
    }
    signal.throwIfAborted();
    const committed = await readStableApproval(
      db,
      owner,
      request.proposalId,
      signal,
      reread,
    );
    if (!committed || committed.result.requestSha256 !== requestSha256) fail();
    return await publishRoot(db, owner, committed, signal, reread);
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}

/** Saved-only public recovery never retries a changed snapshot. */
export async function readWarmupExecutionApproval(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  return (await readApprovalSnapshot(db, owner, id, signal))?.result ?? null;
}

async function readStableApproval(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  reread: { remaining: number },
) {
  try {
    return await readApprovalSnapshot(db, owner, id, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (
      !(error instanceof WarmupExecutionApprovalReadRace) ||
      reread.remaining !== 1
    )
      throw error;
    reread.remaining = 0;
    return await readApprovalSnapshot(db, owner, id, signal);
  }
}
