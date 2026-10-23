import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import {
  warmupExecutionId as uuid,
  warmupExecutionHash as hash,
  warmupExecutionTimestamp as iso,
} from './wallet-warmup-execution-manifest';
import { readWarmupExecutionApproval } from './wallet-warmup-execution-approval';
import { readWarmupExecutionWalletLease } from './wallet-warmup-execution-lease';
import {
  warmupExecutionAuditGenesis,
  auditSavedWarmupExecutionPrefix,
} from './wallet-warmup-execution-audit';
import { warmupProposalSqlTokens } from './wallet-warmup-execution-proposal-schema';
import { WARMUP_EXECUTION_GENESIS_SCHEMA_SHA256 } from './wallet-warmup-execution-genesis-schema';

const ownerSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const requestSchema = z
  .object({ proposalId: uuid, rootSha256: hash, manifestSha256: hash })
  .strict();
const rowSchema = z
  .object({
    owner_id: ownerSchema,
    proposal_id: uuid,
    root_sha256: hash,
    manifest_sha256: hash,
    lease_created_at: iso,
    version: z.literal(0),
    event_sha256: hash,
    checkpoint_sha256: hash,
    recorded_at: iso,
  })
  .strict();

export class WarmupExecutionGenesisError extends Error {
  constructor() {
    super(
      'The original warmup execution starting record is unavailable or changed. Recover the original proposal ID; no execution is authorized.',
    );
    this.name = 'WarmupExecutionGenesisError';
  }
}
function fail(): never {
  throw new WarmupExecutionGenesisError();
}
async function installed(db: D1Database, signal: AbortSignal) {
  signal.throwIfAborted();
  const fk = await db
    .prepare('PRAGMA foreign_keys')
    .first<{ foreign_keys: number }>();
  if (fk?.foreign_keys !== 1) fail();
  const names = Object.keys(WARMUP_EXECUTION_GENESIS_SCHEMA_SHA256);
  if (!names.length) fail();
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
          WARMUP_EXECUTION_GENESIS_SCHEMA_SHA256[row.name]
      )
        fail();
    }
  }
}
async function row(db: D1Database, owner: string, id: string) {
  const value = await db
    .prepare(`SELECT owner_id,proposal_id,root_sha256,manifest_sha256,
 lease_created_at,version,event_sha256,checkpoint_sha256,recorded_at
 FROM wallet_warmup_execution_geneses WHERE owner_id=? AND proposal_id=?`)
    .bind(owner, id)
    .first();
  return value === null ? null : rowSchema.parse(value);
}

/** Read the independently retained owned root and exclusion. No current plan,
 * client head, replacement clock, provider or implicit wallet hold is used. */
async function original(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  const lease = await readWarmupExecutionWalletLease(db, owner, id, signal);
  if (!lease) fail();
  const kept = await readWarmupExecutionApproval(db, owner, id, signal);
  if (
    !kept ||
    kept.status !== 'root-recorded' ||
    !kept.root ||
    kept.rootSha256 !== lease.rootSha256 ||
    kept.manifestSha256 !== lease.manifestSha256 ||
    kept.rootCreatedAt !== lease.rootCreatedAt
  )
    fail();
  const selector = {
    id,
    ownerId: owner,
    consentId: kept.consentId,
    reviewId: kept.reviewId,
    rootSha256: lease.rootSha256,
  };
  const genesis = await warmupExecutionAuditGenesis(
    kept.root,
    kept.approval,
    selector,
    lease.createdAt,
    signal,
  );
  return { lease, kept, selector, genesis };
}

/** Complete reconstruction of the independently stored INITIAL head. This is
 * not a current mutable execution head, event history, resumable checkpoint or
 * proof that any action ran. Late recovery never renews the original time. */
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
  const { lease, kept, selector, genesis } = await original(
    db,
    owner,
    id,
    signal,
  );
  const expectedHead = {
    rootId: id,
    rootSha256: lease.rootSha256,
    manifestSha256: lease.manifestSha256,
    createdAt: lease.createdAt,
    version: before.version,
    eventSha256: before.event_sha256,
    checkpointSha256: before.checkpoint_sha256,
  };
  if (
    before.owner_id !== owner ||
    before.proposal_id !== id ||
    before.root_sha256 !== lease.rootSha256 ||
    before.manifest_sha256 !== lease.manifestSha256 ||
    before.lease_created_at !== lease.createdAt ||
    before.recorded_at < lease.createdAt ||
    canonical(expectedHead) !== canonical(genesis.head)
  )
    fail();
  // Independently selected stored digests must verify the complete empty prefix,
  // rather than accepting a self-consistent caller-supplied checkpoint.
  const audit = await auditSavedWarmupExecutionPrefix(
    kept.root,
    kept.approval,
    selector,
    expectedHead,
    [],
    signal,
  );
  const afterLease = await readWarmupExecutionWalletLease(
    db,
    owner,
    id,
    signal,
  );
  if (
    canonical(afterLease) !== canonical(lease) ||
    canonical(await row(db, owner, id)) !== canonical(before)
  )
    fail();
  signal.throwIfAborted();
  return {
    format: 'wallet-warmup-execution-genesis-v1' as const,
    proposalId: id,
    rootSha256: lease.rootSha256,
    manifestSha256: lease.manifestSha256,
    leaseCreatedAt: lease.createdAt,
    recordedAt: before.recorded_at,
    head: audit.head,
    checkpoint: audit.checkpoint,
    scope: 'durable-initial-audit-only' as const,
    recordedEvents: 0 as const,
    runStarted: false as const,
    currentHeadVerified: false as const,
    receiptEvidenceVerified: false as const,
    currentSourceVerified: false as const,
    financialReservationVerified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    automaticExecutionAllowed: false as const,
  };
}

/** Internal append-only historical metadata. No API, event append, control,
 * dispatcher, release or signer is mounted. Missing leases are never created.
 * SQL recording time is separate from the original audit/lease timestamp. */
export async function retainWarmupExecutionGenesis(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
) {
  try {
    owner = ownerSchema.parse(owner);
    const request = requestSchema.parse(value);
    await installed(db, signal);
    const matches = (
      saved: NonNullable<Awaited<ReturnType<typeof snapshot>>> | null,
    ) =>
      !!saved &&
      saved.rootSha256 === request.rootSha256 &&
      saved.manifestSha256 === request.manifestSha256;
    const prior = await snapshot(db, owner, request.proposalId, signal);
    if (prior) {
      if (!matches(prior)) fail();
      return prior;
    }
    const { lease, genesis } = await original(
      db,
      owner,
      request.proposalId,
      signal,
    );
    if (
      lease.rootSha256 !== request.rootSha256 ||
      lease.manifestSha256 !== request.manifestSha256
    )
      fail();
    signal.throwIfAborted();
    try {
      const saved = await db
        .prepare(`INSERT INTO wallet_warmup_execution_geneses(owner_id,proposal_id,root_sha256,
 manifest_sha256,lease_created_at,version,event_sha256,checkpoint_sha256,recorded_at)
 VALUES(?,?,?,?,?,0,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
        .bind(
          owner,
          request.proposalId,
          lease.rootSha256,
          lease.manifestSha256,
          lease.createdAt,
          genesis.head.eventSha256,
          genesis.head.checkpointSha256,
        )
        .run();
      if (!saved.success || saved.meta.changes !== 1) fail();
    } catch {
      signal.throwIfAborted();
      const recovered = await snapshot(db, owner, request.proposalId, signal);
      if (!matches(recovered)) fail();
      return recovered!;
    }
    const saved = await snapshot(db, owner, request.proposalId, signal);
    if (!matches(saved)) fail();
    return saved!;
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}

/** Saved-only exact-ID recovery; no fresh provider read or write. */
export async function readWarmupExecutionGenesis(
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
