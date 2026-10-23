import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import {
  warmupExecutionId as uuid,
  warmupExecutionHash as hash,
  warmupExecutionTimestamp as iso,
  WARMUP_EXECUTION_POLICY,
} from './wallet-warmup-execution-manifest';
import { readWarmupExecutionGenesis } from './wallet-warmup-execution-genesis';
import { readWarmupExecutionApproval } from './wallet-warmup-execution-approval';
import {
  auditSavedWarmupExecutionPrefix,
  deriveWarmupExecutionControlAppend,
  WARMUP_EXECUTION_AUDIT_BYTES,
  WARMUP_EXECUTION_EVENT_BYTES,
} from './wallet-warmup-execution-audit';
import { warmupProposalSqlTokens } from './wallet-warmup-execution-proposal-schema';
import { WARMUP_EXECUTION_CONTROL_SCHEMA_SHA256 } from './wallet-warmup-execution-control-schema';

const ownerSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const version = z.number().int().min(0).max(WARMUP_EXECUTION_POLICY.modelSteps);
const operation = z.enum(['pause', 'resume', 'stop']);
const requestSchema = z
  .object({
    id: uuid,
    proposalId: uuid,
    rootSha256: hash,
    manifestSha256: hash,
    expectedVersion: version.max(WARMUP_EXECUTION_POLICY.modelSteps - 1),
    expectedEventSha256: hash,
    expectedCheckpointSha256: hash,
    operation,
  })
  .strict();
type Request = z.infer<typeof requestSchema>;
const headSchema = z
  .object({
    owner_id: ownerSchema,
    proposal_id: uuid,
    root_sha256: hash,
    manifest_sha256: hash,
    lease_created_at: iso,
    version,
    event_sha256: hash,
    checkpoint_sha256: hash,
    model_at: iso,
    recorded_at: iso,
    wire_bytes: z.number().int().min(0).max(WARMUP_EXECUTION_AUDIT_BYTES),
    paused: z.union([z.literal(0), z.literal(1)]),
    stopped: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();
const intentSchema = z
  .object({
    owner_id: ownerSchema,
    id: uuid,
    proposal_id: uuid,
    root_sha256: hash,
    manifest_sha256: hash,
    expected_version: version.max(WARMUP_EXECUTION_POLICY.modelSteps - 1),
    expected_event_sha256: hash,
    expected_checkpoint_sha256: hash,
    operation,
    model_at: iso,
  })
  .strict();
const eventSchema = z
  .object({
    owner_id: ownerSchema,
    proposal_id: uuid,
    id: uuid,
    sequence: version.min(1),
    root_sha256: hash,
    manifest_sha256: hash,
    previous_event_sha256: hash,
    previous_checkpoint_sha256: hash,
    event_sha256: hash,
    checkpoint_sha256: hash,
    operation,
    model_at: iso,
    recorded_at: iso,
    wire: z.string().max(WARMUP_EXECUTION_EVENT_BYTES),
  })
  .strict();
type Head = z.infer<typeof headSchema>;
type Intent = z.infer<typeof intentSchema>;
type Event = z.infer<typeof eventSchema>;
const flags = {
  workerControlApplied: false as const,
  leaseReleased: false as const,
  signingAllowed: false as const,
  executionAllowed: false as const,
  automaticExecutionAllowed: false as const,
};
export class WarmupExecutionControlStorageError extends Error {
  constructor() {
    super(
      'Warmup control history changed or is unavailable. Recover the original control ID and head; no worker or wallet action is authorized.',
    );
    this.name = 'WarmupExecutionControlStorageError';
  }
}
function fail(): never {
  throw new WarmupExecutionControlStorageError();
}
async function installed(db: D1Database, signal: AbortSignal) {
  signal.throwIfAborted();
  const fk = await db
    .prepare('PRAGMA foreign_keys')
    .first<{ foreign_keys: number }>();
  if (fk?.foreign_keys !== 1) fail();
  const names = Object.keys(WARMUP_EXECUTION_CONTROL_SCHEMA_SHA256);
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
      new Set(rows.results.map((r) => r.name)).size !== chunk.length ||
      rows.results.some((r) => !chunk.includes(r.name))
    )
      fail();
    for (const row of rows.results) {
      signal.throwIfAborted();
      if (
        typeof row.sql !== 'string' ||
        (await digest(warmupProposalSqlTokens(row.sql))) !==
          WARMUP_EXECUTION_CONTROL_SCHEMA_SHA256[row.name]
      )
        fail();
    }
  }
}
async function headRow(db: D1Database, owner: string, id: string) {
  const value = await db
    .prepare(
      'SELECT * FROM wallet_warmup_execution_control_heads WHERE owner_id=? AND proposal_id=?',
    )
    .bind(owner, id)
    .first();
  return value === null ? null : headSchema.parse(value);
}
async function intentRow(db: D1Database, owner: string, id: string) {
  const value = await db
    .prepare(
      'SELECT * FROM wallet_warmup_execution_control_intents WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first();
  return value === null ? null : intentSchema.parse(value);
}
async function eventRow(db: D1Database, owner: string, id: string) {
  const value = await db
    .prepare(
      'SELECT * FROM wallet_warmup_execution_control_events WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first();
  return value === null ? null : eventSchema.parse(value);
}
function intentRequest(i: Intent): Request {
  return {
    id: i.id,
    proposalId: i.proposal_id,
    rootSha256: i.root_sha256,
    manifestSha256: i.manifest_sha256,
    expectedVersion: i.expected_version,
    expectedEventSha256: i.expected_event_sha256,
    expectedCheckpointSha256: i.expected_checkpoint_sha256,
    operation: i.operation,
  };
}
function auditHead(h: Head) {
  return {
    rootId: h.proposal_id,
    rootSha256: h.root_sha256,
    manifestSha256: h.manifest_sha256,
    createdAt: h.lease_created_at,
    version: h.version,
    eventSha256: h.event_sha256,
    checkpointSha256: h.checkpoint_sha256,
  };
}
function sameExpected(h: ReturnType<typeof auditHead>, r: Request) {
  return (
    h.rootId === r.proposalId &&
    h.rootSha256 === r.rootSha256 &&
    h.manifestSha256 === r.manifestSha256 &&
    h.version === r.expectedVersion &&
    h.eventSha256 === r.expectedEventSha256 &&
    h.checkpointSha256 === r.expectedCheckpointSha256
  );
}
function checkWire(row: Event) {
  const wire = JSON.parse(row.wire);
  if (
    wire.rootId !== row.proposal_id ||
    wire.rootSha256 !== row.root_sha256 ||
    wire.manifestSha256 !== row.manifest_sha256 ||
    wire.sequence !== row.sequence ||
    wire.previousSha256 !== row.previous_event_sha256 ||
    wire.sha256 !== row.event_sha256 ||
    wire.event?.operation !== row.operation ||
    wire.event?.now !== Date.parse(row.model_at) ||
    wire.event?.expectedRootSha256 !== row.manifest_sha256 ||
    wire.event?.expectedVersion !== row.sequence - 1 ||
    row.recorded_at < row.model_at
  )
    fail();
}
type Genesis = NonNullable<
  Awaited<ReturnType<typeof readWarmupExecutionGenesis>>
>;
type Proof = {
  genesis: Genesis;
  kept: NonNullable<Awaited<ReturnType<typeof readWarmupExecutionApproval>>>;
  selector: {
    id: string;
    ownerId: string;
    consentId: string;
    reviewId: string;
    rootSha256: string;
  };
  headers: string;
};
type Scope = { db: D1Database; owner: string; proofs: Map<string, Proof> };
const scopeFor = (db: D1Database, owner: string): Scope => ({
  db,
  owner,
  proofs: new Map(),
});
async function parentHeaders(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  const rows = [];
  // All scalar columns, not partial identifiers or a mutable current-plan view.
  for (const table of [
    'wallet_warmup_execution_geneses',
    'wallet_warmup_execution_wallet_leases',
    'wallet_warmup_execution_roots',
    'wallet_warmup_execution_approvals',
  ]) {
    signal.throwIfAborted();
    const row = await db
      .prepare(`SELECT * FROM ${table} WHERE owner_id=? AND proposal_id=?`)
      .bind(owner, id)
      .first<Record<string, unknown>>();
    signal.throwIfAborted();
    if (!row || row.owner_id !== owner || row.proposal_id !== id) fail();
    rows.push({ table, row });
  }
  return canonical(rows);
}
async function originalProof(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  scope: Scope,
) {
  signal.throwIfAborted();
  if (scope.db !== db || scope.owner !== owner) fail();
  const prior = scope.proofs.get(id);
  if (prior) return prior;
  if (scope.proofs.size) fail();
  // The full original readers still verify all proposal/chunk immutability
  // dependencies as well as the control registry, once per public request.
  const genesis = await readWarmupExecutionGenesis(db, owner, id, signal);
  if (!genesis) return null;
  const before = await parentHeaders(db, owner, id, signal);
  const kept = await readWarmupExecutionApproval(db, owner, id, signal);
  const common = kept && {
    owner_id: owner,
    proposal_id: id,
    consent_id: kept.consentId,
    review_id: kept.reviewId,
    header_sha256: kept.headerSha256,
    terms_sha256: kept.termsSha256,
  };
  const rootHeader = kept && {
    ...common,
    consent_sha256: kept.consentSha256,
    root_sha256: kept.rootSha256,
    manifest_sha256: kept.manifestSha256,
    created_at: kept.rootCreatedAt,
  };
  const expectedHeaders =
    kept &&
    canonical([
      {
        table: 'wallet_warmup_execution_geneses',
        row: {
          owner_id: owner,
          proposal_id: id,
          root_sha256: genesis.rootSha256,
          manifest_sha256: genesis.manifestSha256,
          lease_created_at: genesis.leaseCreatedAt,
          version: 0,
          event_sha256: genesis.head.eventSha256,
          checkpoint_sha256: genesis.head.checkpointSha256,
          recorded_at: genesis.recordedAt,
        },
      },
      {
        table: 'wallet_warmup_execution_wallet_leases',
        row: {
          ...rootHeader,
          root_created_at: kept.rootCreatedAt,
          created_at: genesis.leaseCreatedAt,
        },
      },
      { table: 'wallet_warmup_execution_roots', row: rootHeader },
      {
        table: 'wallet_warmup_execution_approvals',
        row: {
          ...common,
          request_sha256: kept.requestSha256,
          approved_at: kept.approval.approvedAt,
          session_expires_at: kept.approval.sessionExpiresAt,
          pacing_before: kept.pacingBefore,
          acknowledgement: kept.approval.acknowledgement,
        },
      },
    ]);
  if (
    !kept?.root ||
    kept.rootSha256 !== genesis.rootSha256 ||
    kept.manifestSha256 !== genesis.manifestSha256 ||
    before !== expectedHeaders ||
    before !== (await parentHeaders(db, owner, id, signal))
  )
    fail();
  const proof = Object.freeze(
    structuredClone({
      genesis,
      kept,
      selector: {
        id,
        ownerId: owner,
        consentId: kept.consentId,
        reviewId: kept.reviewId,
        rootSha256: genesis.rootSha256,
      },
      headers: before,
    }),
  );
  scope.proofs.set(id, proof);
  return proof;
}
function seed(genesis: Genesis, owner: string): Head {
  return {
    owner_id: owner,
    proposal_id: genesis.proposalId,
    root_sha256: genesis.rootSha256,
    manifest_sha256: genesis.manifestSha256,
    lease_created_at: genesis.leaseCreatedAt,
    version: 0,
    event_sha256: genesis.head.eventSha256,
    checkpoint_sha256: genesis.head.checkpointSha256,
    model_at: genesis.leaseCreatedAt,
    recorded_at: genesis.recordedAt,
    wire_bytes: 0,
    paused: 0,
    stopped: 0,
  };
}
/** SQL joins each immutable event to its original retained control intent.
 * Values are admitted in bounded pages, never restored from the summary. */
function prefix(
  db: D1Database,
  owner: string,
  h: Head,
  genesis: Genesis,
  signal: AbortSignal,
) {
  const metrics = {
    count: 0,
    bytes: 0,
    event: genesis.head.eventSha256,
    checkpoint: genesis.head.checkpointSha256,
    modelAt: genesis.leaseCreatedAt,
    recordedAt: genesis.recordedAt,
  };
  async function* stream() {
    for (;;) {
      signal.throwIfAborted();
      const rows = await db
        .prepare(`SELECT e.* FROM wallet_warmup_execution_control_events e
 JOIN wallet_warmup_execution_control_intents i ON i.owner_id=e.owner_id AND i.id=e.id
 AND i.proposal_id=e.proposal_id AND i.root_sha256=e.root_sha256 AND i.manifest_sha256=e.manifest_sha256
 AND i.operation=e.operation AND i.model_at=e.model_at AND i.expected_version=e.sequence-1
 AND i.expected_event_sha256=e.previous_event_sha256 AND i.expected_checkpoint_sha256=e.previous_checkpoint_sha256
 WHERE e.owner_id=? AND e.proposal_id=? AND e.sequence>? AND e.sequence<=? ORDER BY e.sequence LIMIT 64`)
        .bind(owner, h.proposal_id, metrics.count, h.version)
        .all();
      signal.throwIfAborted();
      if (!rows.success || rows.results.length > 64) fail();
      if (!rows.results.length) return;
      for (const raw of rows.results) {
        const row = eventSchema.parse(raw);
        if (
          row.owner_id !== owner ||
          row.proposal_id !== h.proposal_id ||
          row.root_sha256 !== h.root_sha256 ||
          row.manifest_sha256 !== h.manifest_sha256 ||
          row.sequence !== metrics.count + 1 ||
          row.previous_event_sha256 !== metrics.event ||
          row.previous_checkpoint_sha256 !== metrics.checkpoint ||
          row.model_at < metrics.modelAt ||
          row.model_at < metrics.recordedAt ||
          row.recorded_at < metrics.recordedAt
        )
          fail();
        checkWire(row);
        metrics.count++;
        metrics.bytes += new TextEncoder().encode(row.wire).byteLength;
        if (
          metrics.count > h.version ||
          metrics.bytes > WARMUP_EXECUTION_AUDIT_BYTES
        )
          fail();
        metrics.event = row.event_sha256;
        metrics.checkpoint = row.checkpoint_sha256;
        metrics.modelAt = row.model_at;
        metrics.recordedAt = row.recorded_at;
        yield row.wire;
      }
    }
  }
  return { stream: stream(), metrics };
}
async function state(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  scope: Scope,
) {
  signal.throwIfAborted();
  const proof = await originalProof(db, owner, id, signal, scope);
  if (!proof) return null;
  const { genesis, kept, selector } = proof;
  const before = await headRow(db, owner, id),
    h = before ?? seed(genesis, owner);
  if (
    h.owner_id !== owner ||
    h.proposal_id !== id ||
    h.root_sha256 !== genesis.rootSha256 ||
    h.manifest_sha256 !== genesis.manifestSha256 ||
    h.lease_created_at !== genesis.leaseCreatedAt
  )
    fail();
  const selected = prefix(db, owner, h, genesis, signal);
  const audit = await auditSavedWarmupExecutionPrefix(
    kept.root,
    kept.approval,
    selector,
    auditHead(h),
    selected.stream,
    signal,
  );
  if (
    selected.metrics.count !== h.version ||
    selected.metrics.bytes !== h.wire_bytes ||
    selected.metrics.event !== h.event_sha256 ||
    selected.metrics.checkpoint !== h.checkpoint_sha256 ||
    selected.metrics.modelAt !== h.model_at ||
    selected.metrics.recordedAt !== h.recorded_at ||
    Number(audit.checkpoint.snapshot.paused) !== h.paused ||
    Number(audit.checkpoint.snapshot.stopped) !== h.stopped
  )
    fail();
  if (
    (await parentHeaders(db, owner, id, signal)) !== proof.headers ||
    canonical(await headRow(db, owner, id)) !== canonical(before)
  )
    fail();
  signal.throwIfAborted();
  return {
    genesis,
    kept,
    selector,
    before,
    h,
    view: {
      format: 'wallet-warmup-execution-controls-v1' as const,
      proposalId: id,
      rootSha256: h.root_sha256,
      manifestSha256: h.manifest_sha256,
      head: audit.head,
      checkpoint: audit.checkpoint,
      projection: audit.projection,
      recordedAt: h.recorded_at,
      wireBytes: audit.wireBytes,
      recordedEvents: h.version,
      headRecorded: before !== null,
      scope: 'durable-control-history-only' as const,
      runStarted: false as const,
      currentHeadVerified: false as const,
      receiptEvidenceVerified: false as const,
      currentSourceVerified: false as const,
      financialReservationVerified: false as const,
      ...flags,
    },
  };
}
async function requestState(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  scope: Scope,
) {
  signal.throwIfAborted();
  const before = await intentRow(db, owner, id);
  signal.throwIfAborted();
  if (!before) return null;
  const saved = await state(db, owner, before.proposal_id, signal, scope);
  if (
    !saved ||
    before.owner_id !== owner ||
    before.root_sha256 !== saved.genesis.rootSha256 ||
    before.manifest_sha256 !== saved.genesis.manifestSha256 ||
    before.expected_version > saved.h.version
  )
    fail();
  let priorEvent = saved.genesis.head.eventSha256,
    priorCheckpoint = saved.genesis.head.checkpointSha256,
    priorTime = saved.genesis.recordedAt;
  if (before.expected_version > 0) {
    const prior = await db
      .prepare(
        'SELECT * FROM wallet_warmup_execution_control_events WHERE owner_id=? AND proposal_id=? AND sequence=?',
      )
      .bind(owner, before.proposal_id, before.expected_version)
      .first();
    if (!prior) fail();
    const parsed = eventSchema.parse(prior);
    checkWire(parsed);
    if (
      parsed.owner_id !== owner ||
      parsed.proposal_id !== before.proposal_id ||
      parsed.root_sha256 !== before.root_sha256 ||
      parsed.manifest_sha256 !== before.manifest_sha256 ||
      parsed.sequence !== before.expected_version
    )
      fail();
    priorEvent = parsed.event_sha256;
    priorCheckpoint = parsed.checkpoint_sha256;
    priorTime = parsed.recorded_at;
  }
  if (
    before.expected_event_sha256 !== priorEvent ||
    before.expected_checkpoint_sha256 !== priorCheckpoint ||
    before.model_at < priorTime ||
    before.model_at < saved.genesis.leaseCreatedAt
  )
    fail();
  const event = await eventRow(db, owner, id);
  if (event) {
    checkWire(event);
    if (
      event.owner_id !== owner ||
      event.proposal_id !== before.proposal_id ||
      event.root_sha256 !== before.root_sha256 ||
      event.manifest_sha256 !== before.manifest_sha256 ||
      event.operation !== before.operation ||
      event.model_at !== before.model_at ||
      event.sequence !== before.expected_version + 1 ||
      event.sequence > saved.h.version ||
      event.previous_event_sha256 !== before.expected_event_sha256 ||
      event.previous_checkpoint_sha256 !== before.expected_checkpoint_sha256
    )
      fail();
  }
  if (
    canonical(await intentRow(db, owner, id)) !== canonical(before) ||
    canonical(await eventRow(db, owner, id)) !== canonical(event) ||
    canonical(await headRow(db, owner, before.proposal_id)) !==
      canonical(saved.before)
  )
    fail();
  signal.throwIfAborted();
  return {
    intent: before,
    saved,
    dto: {
      ...intentRequest(before),
      modelAt: before.model_at,
      status: event
        ? ('control-recorded' as const)
        : ('intent-recorded' as const),
      sequence: event?.sequence ?? null,
      eventSha256: event?.event_sha256 ?? null,
      recordedAt: event?.recorded_at ?? null,
      superseded: !event && before.expected_version < saved.h.version,
      scope: 'durable-control-request-only' as const,
      ...flags,
    },
  };
}
/** Saved-only read. A virtual original genesis is clearly distinguished from
 * a stored control head; reading never initializes one or fetches providers. */
export async function readWarmupExecutionControls(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  try {
    owner = ownerSchema.parse(owner);
    id = uuid.parse(id);
    await installed(db, signal);
    return (
      (await state(db, owner, id, signal, scopeFor(db, owner)))?.view ?? null
    );
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}
/** Exact-ID staged/applied recovery, never a renewed control or worker claim. */
export async function readWarmupExecutionControlRequest(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  try {
    owner = ownerSchema.parse(owner);
    id = uuid.parse(id);
    await installed(db, signal);
    return (
      (await requestState(db, owner, id, signal, scopeFor(db, owner)))?.dto ??
      null
    );
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}
/** Internal metadata-only controls. SQL retains the exact request/time BEFORE
 * hashing. A single event INSERT atomically advances its owned head. Lost write
 * responses only recover their original ID; no retry, rebase, release or worker
 * invocation occurs. All future financial runtime gates remain unmounted. */
export async function retainWarmupExecutionControl(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
) {
  try {
    owner = ownerSchema.parse(owner);
    const request = requestSchema.parse(value);
    await installed(db, signal);
    const scope = scopeFor(db, owner);
    const matches = (i: Intent) =>
      canonical(intentRequest(i)) === canonical(request);
    const recover = async () => {
      const kept = await requestState(db, owner, request.id, signal, scope);
      if (!kept || !matches(kept.intent)) fail();
      return { request: kept.dto, history: kept.saved.view };
    };
    let prior = await requestState(db, owner, request.id, signal, scope);
    if (prior && !matches(prior.intent)) fail();
    if (prior?.dto.status === 'control-recorded')
      return { request: prior.dto, history: prior.saved.view };
    let saved =
      prior?.saved ??
      (await state(db, owner, request.proposalId, signal, scope));
    if (!saved || !sameExpected(saved.view.head, request)) fail();
    const model = saved.view.checkpoint.snapshot;
    if (
      model.stopped ||
      (model.completedActions === model.totalActions && !model.pending) ||
      (request.operation === 'pause' && model.paused) ||
      (request.operation === 'resume' && !model.paused)
    )
      fail();
    if (!saved.before) {
      signal.throwIfAborted();
      try {
        const r = await db
          .prepare(
            `INSERT INTO wallet_warmup_execution_control_heads(owner_id,proposal_id,root_sha256,manifest_sha256,lease_created_at,version,event_sha256,checkpoint_sha256,model_at,recorded_at,wire_bytes,paused,stopped) VALUES(?,?,?,?,?,0,?,?,?,?,0,0,0)`,
          )
          .bind(
            owner,
            request.proposalId,
            saved.h.root_sha256,
            saved.h.manifest_sha256,
            saved.h.lease_created_at,
            saved.h.event_sha256,
            saved.h.checkpoint_sha256,
            saved.h.model_at,
            saved.h.recorded_at,
          )
          .run();
        if (!r.success) fail();
      } catch {
        signal.throwIfAborted();
        if (!(await headRow(db, owner, request.proposalId))) fail();
      }
      saved = await state(db, owner, request.proposalId, signal, scope);
      if (!saved?.before || !sameExpected(saved.view.head, request)) fail();
    }
    if (!prior) {
      signal.throwIfAborted();
      try {
        const r = await db
          .prepare(
            `INSERT INTO wallet_warmup_execution_control_intents(owner_id,id,proposal_id,root_sha256,manifest_sha256,expected_version,expected_event_sha256,expected_checkpoint_sha256,operation,model_at) VALUES(?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
          )
          .bind(
            owner,
            request.id,
            request.proposalId,
            request.rootSha256,
            request.manifestSha256,
            request.expectedVersion,
            request.expectedEventSha256,
            request.expectedCheckpointSha256,
            request.operation,
          )
          .run();
        if (!r.success) fail();
      } catch {
        signal.throwIfAborted();
        return await recover();
      }
      prior = await requestState(db, owner, request.id, signal, scope);
      if (!prior || !matches(prior.intent)) fail();
    }
    const selected = prior.saved;
    if (!sameExpected(selected.view.head, request)) fail();
    const candidate = await deriveWarmupExecutionControlAppend(
      selected.kept.root,
      selected.kept.approval,
      selected.selector,
      selected.view.head,
      prefix(db, owner, selected.h, selected.genesis, signal).stream,
      { operation: request.operation, now: Date.parse(prior.intent.model_at) },
      signal,
    );
    signal.throwIfAborted();
    const proof = scope.proofs.get(request.proposalId);
    if (
      !proof ||
      (await parentHeaders(db, owner, request.proposalId, signal)) !==
        proof.headers
    )
      fail();
    if (
      canonical(await headRow(db, owner, request.proposalId)) !==
      canonical(selected.before)
    )
      fail();
    signal.throwIfAborted();
    try {
      const r = await db
        .prepare(
          `INSERT INTO wallet_warmup_execution_control_events(owner_id,proposal_id,id,sequence,root_sha256,manifest_sha256,previous_event_sha256,previous_checkpoint_sha256,event_sha256,checkpoint_sha256,operation,model_at,recorded_at,wire) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?)`,
        )
        .bind(
          owner,
          request.proposalId,
          request.id,
          candidate.head.version,
          request.rootSha256,
          request.manifestSha256,
          request.expectedEventSha256,
          request.expectedCheckpointSha256,
          candidate.head.eventSha256,
          candidate.head.checkpointSha256,
          request.operation,
          prior.intent.model_at,
          candidate.wire,
        )
        .run();
      // D1 and libsql count trigger effects differently. Retained rows and the
      // complete audited head, rather than changes===1, establish the outcome.
      if (!r.success) fail();
    } catch {
      signal.throwIfAborted();
      return await recover();
    }
    return await recover();
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}
