import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { readWalletWarmupSessionConsent } from './wallet-warmup-session-consent';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { replayWalletWarmupSessionJournal as replay } from './wallet-warmup-session-replay';
import { reviewWalletWarmupSession } from './wallet-warmup-session-review';
import { warmupCycleProgress } from './warmup-cycle-progress';
import {
  warmupLotPerformance,
  type PerformanceBuy,
  type PerformanceSell,
} from './warmup-lot-performance';
import type { SavedWarmup } from './wallet-warmup-storage';
import { WARMUP_SESSION_REVIEW_GAP_MS } from './wallet-warmup-session-sequence';
import { parseWalletWarmupSessionSettlementRecord } from './wallet-warmup-session-settlement-record';

const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const action = z.string().min(1).max(1024);
// Finalized settlement needs a separately guarded real-receipt adapter. It is
// deliberately unavailable through this observation/control storage writer.
const command = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('begin-review'), actionId: action }).strict(),
  z.object({ operation: z.literal('submitted'), actionId: action }).strict(),
  z.object({ operation: z.literal('unknown'), actionId: action }).strict(),
  z.object({ operation: z.literal('pause') }).strict(),
  z.object({ operation: z.literal('resume') }).strict(),
  z.object({ operation: z.literal('stop') }).strict(),
]);
const rootInput = z
  .object({ id: uuid, consentId: uuid, termsSha256: hash })
  .strict();
const appendInput = z
  .object({
    id: uuid,
    journalId: uuid,
    expectedVersion: z.number().int().min(0).max(4095),
    expectedHeadSha256: hash,
    command,
  })
  .strict();
type RootRow = {
  id: string;
  consent_id: string;
  terms_sha256: string;
  started_at: string;
  source_document: string;
  source_sha256: string;
  initial_sha256: string;
  created_at: string;
  events: string;
  head_version: number;
  head_sha256: string;
  document_bytes: number;
  head_updated_at: string;
};
export class WalletWarmupJournalError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
function fail(
  message = 'Warmup journal changed. Recover its original ID.',
  status = 409,
): never {
  throw new WalletWarmupJournalError(message, status);
}
function ownerId(owner: string) {
  if (typeof owner !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(owner))
    fail('Verified session owner required.', 400);
}
function clock(at: number) {
  if (
    !Number.isSafeInteger(at) ||
    at < 0 ||
    at > 8640000000000000 - WARMUP_SESSION_REVIEW_GAP_MS
  )
    fail();
  return new Date(at).toISOString();
}
async function installed(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('wallet_warmup_session_journals_insert','wallet_warmup_session_journals_no_update','wallet_warmup_session_journals_no_delete','wallet_warmup_session_journal_events_insert','wallet_warmup_session_journal_events_no_update','wallet_warmup_session_journal_events_no_delete','wallet_warmup_session_journals_head','wallet_warmup_session_journal_heads_insert','wallet_warmup_session_journal_heads_update','wallet_warmup_session_journal_heads_no_delete','wallet_warmup_session_journal_events_head','wallet_warmup_session_settlements_insert','wallet_warmup_session_settlements_no_update','wallet_warmup_session_settlements_no_delete','wallet_warmup_session_settlements_apply')",
    )
    .first<{ n: number }>();
  if (row?.n !== 15) fail('Warmup recovery storage is not installed.', 503);
}
async function context(
  db: D1Database,
  owner: string,
  consentId: string,
  signal: AbortSignal,
) {
  const consent = await readWalletWarmupSessionConsent(
    db,
    owner,
    consentId,
    signal,
  );
  if (!consent) fail('Choose an owned saved plan approval.', 404);
  const row = await db
    .prepare(
      'SELECT plan_id,plan_revision,source,source_sha256,document,reviewed_at,review_expires_at FROM wallet_warmup_session_reviews WHERE owner_id=? AND id=?',
    )
    .bind(owner, consent.terms.reviewId)
    .first<{
      plan_id: string;
      plan_revision: number;
      source: string;
      source_sha256: string;
      document: string;
      reviewed_at: string;
      review_expires_at: string;
    }>();
  signal.throwIfAborted();
  if (
    !row ||
    row.document !== consent.terms.reviewDocument ||
    (await digest(row.source)) !== row.source_sha256
  )
    fail();
  const source = JSON.parse(row.source);
  const plan: SavedWarmup = {
    id: row.plan_id,
    revision: row.plan_revision,
    archived: false,
    updatedAt: source.planUpdatedAt,
    document: JSON.parse(source.planDocument),
  };
  const buys = source.buys.map((v: Record<string, unknown>) => ({
    ...v,
    document: JSON.parse(v.document as string),
  })) as PerformanceBuy[];
  const sells = source.sells.map((v: Record<string, unknown>) => ({
    ...v,
    document: JSON.parse(v.document as string),
  })) as PerformanceSell[];
  const progress = warmupCycleProgress(plan, buys, sells, [], false);
  const performance = warmupLotPerformance(
    buys,
    sells,
    progress.steps.flatMap((step) => step.buyIds),
  );
  const review = reviewWalletWarmupSession(
    plan,
    progress,
    performance,
    Date.parse(row.reviewed_at),
  );
  if ((await digest(review.contextKey)) !== consent.terms.reviewSha256) fail();
  const { contextKey: _key, ...manifest } = review;
  const {
    format: _format,
    contextSha256: _hash,
    sourceSha256: _sourceHash,
    ...original
  } = JSON.parse(row.document);
  if (canonical(manifest) !== canonical(original)) fail();
  const sourceDocument = canonical({
    review,
    reviewExpiresAt: row.review_expires_at,
  });
  const sourceSha256 = await digest(sourceDocument);
  const initialSha256 = await digest(
    JSON.stringify([
      'wallet-warmup-session-journal-v1',
      sourceSha256,
      consent.createdAt,
    ]),
  );
  signal.throwIfAborted();
  return { consent, plan, sourceDocument, sourceSha256, initialSha256 };
}
async function raw(db: D1Database, owner: string, id: string) {
  // Root and the ordered complete event vector are obtained in ONE SQL snapshot.
  return db
    .prepare(`SELECT j.*,h.version AS head_version,h.head_sha256,h.document_bytes,h.updated_at AS head_updated_at,COALESCE((SELECT json_group_array(json(v)) FROM
    (SELECT json_object('id',e.id,'document',e.document,'event_sha256',e.event_sha256,'version',e.version,'previous_sha256',e.previous_sha256,'created_at',e.created_at,'proof',json((SELECT json_object('document',p.document,'record_sha256',p.record_sha256,'event_document',p.event_document,'event_sha256',p.event_sha256,'mode',p.mode) FROM wallet_warmup_session_settlements p WHERE p.owner_id=e.owner_id AND p.journal_id=e.journal_id AND p.id=e.id))) AS v
     FROM wallet_warmup_session_journal_events e WHERE e.owner_id=j.owner_id AND e.journal_id=j.id ORDER BY e.version)), '[]') AS events
    FROM wallet_warmup_session_journals j LEFT JOIN wallet_warmup_session_journal_heads h ON h.owner_id=j.owner_id AND h.journal_id=j.id WHERE j.owner_id=? AND j.id=?`)
    .bind(owner, id)
    .first<RootRow>();
}
async function decode(
  db: D1Database,
  owner: string,
  row: RootRow,
  signal: AbortSignal,
  now: number,
) {
  const c = await context(db, owner, row.consent_id, signal);
  if (
    row.terms_sha256 !== c.consent.termsSha256 ||
    row.started_at !== c.consent.createdAt ||
    row.source_document !== c.sourceDocument ||
    row.source_sha256 !== c.sourceSha256 ||
    row.initial_sha256 !== c.initialSha256 ||
    clock(Date.parse(row.created_at)) !== row.created_at ||
    row.created_at < row.started_at ||
    Date.parse(row.created_at) > now
  )
    fail();
  const events = z
    .array(
      z
        .object({
          id: uuid,
          document: z.string(),
          event_sha256: hash,
          version: z.number().int().min(1).max(4096),
          previous_sha256: hash,
          created_at: z.string(),
          proof: z
            .object({
              document: z.string().max(16384),
              record_sha256: hash,
              event_document: z.string(),
              event_sha256: hash,
              mode: z.enum(['applied', 'held']),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    )
    .max(4096)
    .parse(JSON.parse(row.events));
  const ids = new Set<string>();
  const originalActions = new Map<string, string>(
    JSON.parse(row.source_document).review.actions.map((a: { id: string }) => [
      a.id,
      canonical(a),
    ]),
  );
  for (const event of events) {
    const document = JSON.parse(event.document);
    if (
      ids.has(event.id) ||
      (await digest(event.document)) !== event.event_sha256 ||
      document.version !== event.version ||
      document.previousSha256 !== event.previous_sha256 ||
      document.at !== event.created_at ||
      document.eventId !== event.id
    )
      fail();
    if (
      document.operation === 'finalized' ||
      document.proofSha256 !== undefined
    ) {
      if (
        !event.proof ||
        event.proof.event_document !== event.document ||
        event.proof.event_sha256 !== event.event_sha256 ||
        document.proofSha256 !== event.proof.record_sha256
      )
        return fail();
      const proof = await parseWalletWarmupSessionSettlementRecord(
        event.proof.document,
        event.proof.record_sha256,
      );
      if (
        proof.id !== event.id ||
        proof.journalId !== row.id ||
        proof.version !== event.version - 1 ||
        proof.headSha256 !== event.previous_sha256 ||
        proof.createdAt !== event.created_at ||
        proof.actionId !== document.actionId ||
        proof.mode !== event.proof.mode ||
        canonical(proof.candidate.action) !==
          originalActions.get(proof.actionId) ||
        (proof.mode === 'applied'
          ? document.operation !== 'finalized' ||
            canonical(proof.settlement) !== canonical(document.settlement)
          : document.operation !== 'unknown' ||
            document.settlement !== undefined)
      )
        return fail();
    } else if (event.proof !== null) return fail();
    ids.add(event.id);
  }
  const anchor = {
    sourceSha256: row.source_sha256,
    startedAt: row.started_at,
    version: row.head_version,
    headSha256: row.head_sha256,
  };
  const bytes =
    new TextEncoder().encode(row.source_document).byteLength +
    events.reduce(
      (sum, e) => sum + new TextEncoder().encode(e.document).byteLength,
      0,
    );
  if (
    row.head_version !== events.length ||
    row.document_bytes !== bytes ||
    row.head_updated_at !== (events.at(-1)?.created_at ?? row.started_at) ||
    row.head_sha256 !== (events.at(-1)?.event_sha256 ?? row.initial_sha256)
  )
    fail();
  const state = await replay(
    row.source_document,
    c.plan,
    anchor,
    events.map((e) => e.document),
    now,
  );
  signal.throwIfAborted();
  return {
    id: row.id,
    consentId: row.consent_id,
    termsSha256: row.terms_sha256,
    createdAt: row.created_at,
    ...state,
    // Server-internal append/recovery inputs. Never publish this object as an API DTO.
    sourceDocument: row.source_document,
    plan: c.plan,
    anchor,
    events,
  };
}
/** Internal owner-scoped recovery. No new action or execution grant is created. */
export async function readWalletWarmupSessionJournal(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  now = Date.now(),
) {
  ownerId(owner);
  uuid.parse(id);
  clock(now);
  signal.throwIfAborted();
  await installed(db);
  const row = await raw(db, owner, id);
  signal.throwIfAborted();
  if (!row) return null;
  try {
    return await decode(db, owner, row, signal, now);
  } catch {
    signal.throwIfAborted();
    return fail(
      'Retained warmup recovery history is unavailable or differs.',
      503,
    );
  }
}
/** Saves recovery metadata only, NOT a session start or permission to run. */
export async function retainWalletWarmupSessionJournal(
  db: D1Database,
  owner: string,
  value: unknown,
  recordRequested: boolean,
  signal: AbortSignal,
  now: () => number = Date.now,
) {
  ownerId(owner);
  if (recordRequested !== true)
    fail('Recording recovery history requires an explicit request.', 400);
  const input = rootInput.parse(value);
  const prior = await readWalletWarmupSessionJournal(
    db,
    owner,
    input.id,
    signal,
    now(),
  );
  if (prior) {
    if (
      prior.consentId !== input.consentId ||
      prior.termsSha256 !== input.termsSha256
    )
      fail();
    return prior;
  }
  const c = await context(db, owner, input.consentId, signal);
  if (c.consent.termsSha256 !== input.termsSha256) fail();
  if (new TextEncoder().encode(c.sourceDocument).byteLength > 1572864)
    fail('Warmup recovery source exceeds retained capacity.');
  const createdAt = clock(now());
  if (createdAt < c.consent.createdAt) fail();
  signal.throwIfAborted();
  try {
    await db
      .prepare(
        'INSERT INTO wallet_warmup_session_journals(owner_id,id,consent_id,terms_sha256,started_at,source_document,source_sha256,initial_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        owner,
        input.id,
        input.consentId,
        input.termsSha256,
        c.consent.createdAt,
        c.sourceDocument,
        c.sourceSha256,
        c.initialSha256,
        createdAt,
      )
      .run();
  } catch {
    /* A rejected response cannot prove that the INSERT did not commit. */
  }
  const saved = await readWalletWarmupSessionJournal(
    db,
    owner,
    input.id,
    AbortSignal.timeout(15000),
    now(),
  );
  if (
    !saved ||
    saved.consentId !== input.consentId ||
    saved.termsSha256 !== input.termsSha256
  )
    fail();
  signal.throwIfAborted();
  return saved;
}
/**
 * Internal consistency journal, not receipt proof or a runtime entry point.
 * A future verified adapter must bind finalized evidence under its write guards
 * before this can become an authoritative execution/settlement path.
 */
export async function appendWalletWarmupSessionJournal(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
  now: () => number = Date.now,
) {
  ownerId(owner);
  const input = appendInput.parse(value);
  const current = await readWalletWarmupSessionJournal(
    db,
    owner,
    input.journalId,
    signal,
    now(),
  );
  if (!current) fail('Recover the owned journal first.', 404);
  const prior = current.events.find((e) => e.id === input.id);
  if (prior) {
    const event = JSON.parse(prior.document);
    const { at: _at, eventId, version, previousSha256, ...command } = event;
    if (
      eventId !== input.id ||
      version !== input.expectedVersion + 1 ||
      previousSha256 !== input.expectedHeadSha256 ||
      canonical(command) !== canonical(input.command)
    )
      fail();
    return current;
  }
  if (
    current.version !== input.expectedVersion ||
    current.headSha256 !== input.expectedHeadSha256
  )
    fail();
  // Caller command cannot override server-generated time, version or predecessor.
  if (
    ['at', 'version', 'previousSha256'].some((key) =>
      Object.hasOwn(input.command, key),
    )
  )
    fail();
  const at = now();
  const document = canonical({
    ...input.command,
    eventId: input.id,
    at: clock(at),
    version: current.version + 1,
    previousSha256: current.headSha256,
  });
  const eventSha256 = await digest(document);
  await replay(
    current.sourceDocument,
    current.plan,
    {
      ...current.anchor,
      version: current.version + 1,
      headSha256: eventSha256,
    },
    [...current.events.map((e) => e.document), document],
    at,
  );
  // An asynchronous digest/replay cannot preserve an expired begin-review slot.
  // Other observations must remain recoverable after expiry.
  const writeAt = now();
  clock(writeAt);
  if (
    writeAt < at ||
    (input.command.operation === 'begin-review' &&
      writeAt >= Date.parse(current.snapshot.sourceReviewExpiresAt))
  )
    fail();
  signal.throwIfAborted();
  try {
    await db
      .prepare(
        'INSERT INTO wallet_warmup_session_journal_events(owner_id,journal_id,id,version,previous_sha256,document,event_sha256,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        owner,
        input.journalId,
        input.id,
        current.version + 1,
        current.headSha256,
        document,
        eventSha256,
        clock(at),
      )
      .run();
  } catch {
    /* Recover only this identity; never retry the INSERT. */
  }
  const saved = await readWalletWarmupSessionJournal(
    db,
    owner,
    input.journalId,
    AbortSignal.timeout(15000),
    now(),
  );
  if (
    !saved?.events.some(
      (e) =>
        e.id === input.id &&
        e.document === document &&
        e.event_sha256 === eventSha256,
    )
  )
    fail();
  signal.throwIfAborted();
  return saved;
}
