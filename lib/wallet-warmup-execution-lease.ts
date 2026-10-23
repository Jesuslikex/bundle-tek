import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import {
  warmupExecutionId as uuid,
  warmupExecutionHash as hash,
  warmupExecutionTimestamp as iso,
} from './wallet-warmup-execution-manifest';
import { readWarmupExecutionApproval } from './wallet-warmup-execution-approval';
import { warmupProposalSqlTokens } from './wallet-warmup-execution-proposal-schema';
import { WARMUP_EXECUTION_LEASE_SCHEMA_SHA256 } from './wallet-warmup-execution-lease-schema';

const ownerSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const requestSchema = z
  .object({ proposalId: uuid, rootSha256: hash, manifestSha256: hash })
  .strict();
const rowSchema = z
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
    root_created_at: iso,
    created_at: iso,
  })
  .strict();
const walletSchema = z
  .object({
    owner_id: ownerSchema,
    proposal_id: uuid,
    root_sha256: hash,
    wallet_address: z.string().min(32).max(44),
    wallet_revision: z.number().int().positive().max(999999999),
  })
  .strict();

export class WarmupExecutionWalletLeaseError extends Error {
  constructor() {
    super(
      'Warmup wallet exclusion is unavailable or changed. Recover the original proposal ID before requesting other wallet work.',
    );
    this.name = 'WarmupExecutionWalletLeaseError';
  }
}
function fail(): never {
  throw new WarmupExecutionWalletLeaseError();
}

async function installed(db: D1Database, signal: AbortSignal) {
  signal.throwIfAborted();
  const names = Object.keys(WARMUP_EXECUTION_LEASE_SCHEMA_SHA256);
  const fk = await db
    .prepare('PRAGMA foreign_keys')
    .first<{ foreign_keys: number }>();
  signal.throwIfAborted();
  if (fk?.foreign_keys !== 1 || names.length === 0) fail();
  // Include every dependency while staying below D1's bound-variable ceiling.
  for (let offset = 0; offset < names.length; offset += 64) {
    signal.throwIfAborted();
    const chunk = names.slice(offset, offset + 64);
    const rows = await db
      .prepare(
        `SELECT name,sql FROM sqlite_master WHERE name IN (${chunk.map(() => '?').join(',')})`,
      )
      .bind(...chunk)
      .all<{ name: string; sql: string }>();
    signal.throwIfAborted();
    if (
      !rows.success ||
      rows.results.length !== chunk.length ||
      new Set(rows.results.map((row) => row.name)).size !== chunk.length ||
      rows.results.some((row) => !chunk.includes(row.name))
    )
      fail();
    for (const row of rows.results) {
      signal.throwIfAborted();
      if (
        typeof row.sql !== 'string' ||
        (await digest(warmupProposalSqlTokens(row.sql))) !==
          WARMUP_EXECUTION_LEASE_SCHEMA_SHA256[row.name]
      )
        fail();
    }
  }
}

async function row(db: D1Database, owner: string, id: string) {
  const value = await db
    .prepare(`SELECT owner_id,proposal_id,consent_id,review_id,header_sha256,
 terms_sha256,consent_sha256,root_sha256,manifest_sha256,root_created_at,created_at
 FROM wallet_warmup_execution_wallet_leases WHERE owner_id=? AND proposal_id=?`)
    .bind(owner, id)
    .first();
  return value === null ? null : rowSchema.parse(value);
}

/** Historical reads reconstruct the original owned root, not current balances,
 * a renewed deadline or a caller's wallet list. A recorded lease never vanishes
 * because time passed, a plan was archived or a session was stopped. */
async function snapshot(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const before = await row(db, owner, id);
  signal.throwIfAborted();
  if (!before) return null;
  const kept = await readWarmupExecutionApproval(db, owner, id, signal);
  if (
    !kept ||
    kept.status !== 'root-recorded' ||
    !kept.root ||
    !kept.rootCreatedAt ||
    before.owner_id !== owner ||
    before.proposal_id !== id ||
    before.consent_id !== kept.consentId ||
    before.review_id !== kept.reviewId ||
    before.header_sha256 !== kept.headerSha256 ||
    before.terms_sha256 !== kept.termsSha256 ||
    before.consent_sha256 !== kept.consentSha256 ||
    before.root_sha256 !== kept.rootSha256 ||
    before.manifest_sha256 !== kept.manifestSha256 ||
    before.root_created_at !== kept.rootCreatedAt ||
    before.created_at < kept.rootCreatedAt ||
    before.created_at >= kept.proposalExpiresAt ||
    before.created_at >= kept.pacingBefore ||
    before.created_at >= kept.root.terms.intent.expiresAt ||
    before.created_at >= kept.root.terms.review.reviewExpiresAt
  )
    fail();
  const expected = kept.root.terms.intent.wallets
    .map((wallet) => ({
      wallet: wallet.wallet,
      walletRevision: wallet.revision,
    }))
    .sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
  const projected = await db
    .prepare(`SELECT owner_id,proposal_id,root_sha256,wallet_address,wallet_revision
 FROM wallet_warmup_execution_held_wallets WHERE owner_id=? AND proposal_id=? ORDER BY wallet_address LIMIT 21`)
    .bind(owner, id)
    .all();
  signal.throwIfAborted();
  if (!projected.success) fail();
  const actual = projected.results.map((value) => {
    const wallet = walletSchema.parse(value);
    if (
      wallet.owner_id !== owner ||
      wallet.proposal_id !== id ||
      wallet.root_sha256 !== kept.rootSha256
    )
      fail();
    return {
      wallet: wallet.wallet_address,
      walletRevision: wallet.wallet_revision,
    };
  });
  if (
    canonical(actual) !== canonical(expected) ||
    canonical(await row(db, owner, id)) !== canonical(before)
  )
    fail();
  signal.throwIfAborted();
  return {
    format: 'wallet-warmup-execution-wallet-lease-v1' as const,
    proposalId: id,
    rootSha256: before.root_sha256,
    manifestSha256: before.manifest_sha256,
    rootCreatedAt: before.root_created_at,
    createdAt: before.created_at,
    wallets: expected,
    scope: 'durable-wallet-exclusion-only' as const,
    walletHoldRecorded: true as const,
    humanApprovalVerified: false as const,
    currentSourceVerified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    automaticExecutionAllowed: false as const,
  };
}

/** Internal lock admission only. No HTTP, signer, dispatcher or strategy caller
 * is mounted. SQL checks the entire original roster/current source in the same
 * insertion snapshot. No client wallet, clock, outcome or expiry is accepted.
 * This header has no release transition; a verified future reconciliation
 * protocol is required before any execution flow can use these holds. */
export async function retainWarmupExecutionWalletLease(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
) {
  try {
    owner = ownerSchema.parse(owner);
    const request = requestSchema.parse(value);
    await installed(db, signal);
    const prior = await snapshot(db, owner, request.proposalId, signal);
    if (prior) {
      if (
        prior.rootSha256 !== request.rootSha256 ||
        prior.manifestSha256 !== request.manifestSha256
      )
        fail();
      return prior;
    }
    const kept = await readWarmupExecutionApproval(
      db,
      owner,
      request.proposalId,
      signal,
    );
    if (
      !kept ||
      kept.status !== 'root-recorded' ||
      !kept.root ||
      !kept.rootCreatedAt ||
      kept.rootSha256 !== request.rootSha256 ||
      kept.manifestSha256 !== request.manifestSha256
    )
      fail();
    signal.throwIfAborted();
    try {
      const inserted = await db
        .prepare(`INSERT INTO wallet_warmup_execution_wallet_leases(owner_id,proposal_id,consent_id,review_id,
 header_sha256,terms_sha256,consent_sha256,root_sha256,manifest_sha256,root_created_at,created_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
        .bind(
          owner,
          request.proposalId,
          kept.consentId,
          kept.reviewId,
          kept.headerSha256,
          kept.termsSha256,
          kept.consentSha256,
          request.rootSha256,
          request.manifestSha256,
          kept.rootCreatedAt,
        )
        .run();
      if (!inserted.success || inserted.meta.changes !== 1) fail();
    } catch {
      // An interrupted/lost response can only recover the same immutable row.
      // Never retry the write, create a new identity or release an unknown hold.
      signal.throwIfAborted();
      const recovered = await snapshot(db, owner, request.proposalId, signal);
      if (
        !recovered ||
        recovered.rootSha256 !== request.rootSha256 ||
        recovered.manifestSha256 !== request.manifestSha256
      )
        fail();
      return recovered;
    }
    signal.throwIfAborted();
    const saved = await snapshot(db, owner, request.proposalId, signal);
    if (
      !saved ||
      saved.rootSha256 !== request.rootSha256 ||
      saved.manifestSha256 !== request.manifestSha256
    )
      fail();
    return saved;
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}

/** Saved-only, no provider call, retry, renewal or release. */
export async function readWarmupExecutionWalletLease(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  try {
    owner = ownerSchema.parse(owner);
    id = uuid.parse(id);
    await installed(db, signal);
    return await snapshot(db, owner, id, signal);
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}
