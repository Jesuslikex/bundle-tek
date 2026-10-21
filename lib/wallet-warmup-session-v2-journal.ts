import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { readWalletWarmupV2Consent } from './wallet-warmup-session-v2-consent';
import type { WalletWarmupSessionReview } from './wallet-warmup-session-review';

export const WARMUP_V2_JOURNAL_LIMITS = Object.freeze({
  events: 65536,
  bytes: 33554432,
  eventBytes: 2048,
  stopBytes: 4096,
});
const uuid = z.uuid().refine((v) => v === v.toLowerCase()),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  iso = z.iso.datetime().refine((v) => new Date(v).toISOString() === v);
export const warmupV2Control = z.enum([
  'begin-review',
  'pause',
  'resume',
  'stop',
]);
const rootInput = z
  .object({ id: uuid, consentId: uuid, termsSha256: hash })
  .strict();
const controlInput = z
  .object({
    id: uuid,
    journalId: uuid,
    version: z
      .number()
      .int()
      .min(0)
      .max(WARMUP_V2_JOURNAL_LIMITS.events - 1),
    headSha256: hash,
    control: warmupV2Control,
  })
  .strict();
const base = {
  format: z.literal('wallet-warmup-session-event-v2'),
  eventId: uuid,
  version: z.number().int().min(1).max(WARMUP_V2_JOURNAL_LIMITS.events),
  previousSha256: hash,
  at: iso,
};
const eventSchema = z.discriminatedUnion('operation', [
  z
    .object({
      ...base,
      operation: z.literal('begin-review'),
      actionId: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({ ...base, operation: z.enum(['pause', 'resume', 'stop']) })
    .strict(),
]);
type Root = {
  owner_id: string;
  id: string;
  consent_id: string;
  review_id: string;
  terms_sha256: string;
  initial_sha256: string;
  created_at: string;
  head_version: number;
  head_sha256: string;
  document_bytes: number;
  head_updated_at: string;
};
type EventRow = {
  id: string;
  version: number;
  previous_sha256: string;
  document: string;
  event_sha256: string;
  created_at: string;
};
export class WalletWarmupV2JournalError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly recoveryId?: string,
  ) {
    super(message);
  }
}
function fail(
  message = 'Versioned session history changed. Recover the original request.',
  status = 409,
): never {
  throw new WalletWarmupV2JournalError(message, status);
}
function ownerId(owner: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(owner))
    fail('Verified owner required.', 400);
}
function clock(at: number) {
  if (!Number.isSafeInteger(at) || at < 0 || at > 8640000000000000) fail();
  return new Date(at).toISOString();
}
export function warmupV2JournalControlFits(
  version: number,
  bytes: number,
  nextBytes: number,
  control: z.infer<typeof warmupV2Control>,
) {
  const l = WARMUP_V2_JOURNAL_LIMITS;
  return (
    Number.isSafeInteger(version) &&
    version >= 0 &&
    Number.isSafeInteger(bytes) &&
    bytes >= 0 &&
    Number.isSafeInteger(nextBytes) &&
    nextBytes > 0 &&
    nextBytes <= l.eventBytes &&
    version < l.events &&
    bytes + nextBytes <= l.bytes &&
    (control === 'stop' ||
      (version < l.events - 1 && bytes + nextBytes <= l.bytes - l.stopBytes))
  );
}
async function installed(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('wallet_warmup_session_journals_v2_insert','wallet_warmup_session_journals_v2_no_update','wallet_warmup_session_journals_v2_no_delete','wallet_warmup_session_journal_events_v2_insert','wallet_warmup_session_journal_events_v2_no_update','wallet_warmup_session_journal_events_v2_no_delete','wallet_warmup_session_journal_heads_v2_insert','wallet_warmup_session_journal_heads_v2_update','wallet_warmup_session_journal_heads_v2_no_delete','wallet_warmup_session_journals_v2_head','wallet_warmup_session_journal_events_v2_head','wallet_warmup_session_journals_legacy_id_isolation','wallet_warmup_session_v2_review_exclusion','wallet_warmup_session_legacy_review_exclusion')",
    )
    .first<{ n: number }>();
  if (row?.n !== 14)
    fail('Versioned warmup recovery storage is not installed.', 503);
}
async function raw(db: D1Database, owner: string, id: string) {
  return db
    .prepare(`SELECT j.*,h.version AS head_version,h.head_sha256,h.document_bytes,h.updated_at AS head_updated_at
 FROM wallet_warmup_session_journals_v2 j LEFT JOIN wallet_warmup_session_journal_heads_v2 h ON h.owner_id=j.owner_id AND h.journal_id=j.id WHERE j.owner_id=? AND j.id=?`)
    .bind(owner, id)
    .first<Root>();
}
/** Pin the captured immutable prefix. Each query returns <=256 separate <=2KiB
 * documents, never a giant SQL string. Concurrent append can only add versions
 * above the pinned head; final replay must still exactly match that head. */
async function readPrefix(
  db: D1Database,
  owner: string,
  id: string,
  version: number,
  signal: AbortSignal,
) {
  const rows: EventRow[] = [];
  for (let first = 1; first <= version; first += 4096) {
    signal.throwIfAborted();
    const statements = [];
    for (
      let lower = first;
      lower <= Math.min(version, first + 4095);
      lower += 256
    ) {
      statements.push(
        db
          .prepare(
            'SELECT id,version,previous_sha256,document,event_sha256,created_at FROM wallet_warmup_session_journal_events_v2 WHERE owner_id=? AND journal_id=? AND version>=? AND version<=? ORDER BY version',
          )
          .bind(owner, id, lower, Math.min(version, lower + 255)),
      );
    }
    const pages = await db.batch<EventRow>(statements);
    signal.throwIfAborted();
    if (pages.length !== statements.length) fail();
    for (const [index, page] of pages.entries()) {
      const lower = first + index * 256,
        count = Math.min(version, lower + 255) - lower + 1;
      if (!page.success || page.results.length !== count) fail();
      for (const [offset, row] of page.results.entries()) {
        if (
          row.version !== lower + offset ||
          typeof row.document !== 'string' ||
          new TextEncoder().encode(row.document).byteLength > 2048
        )
          fail();
        rows.push(row);
      }
    }
  }
  return rows;
}
async function initial(
  id: string,
  consentId: string,
  termsSha256: string,
  createdAt: string,
) {
  return digest(
    canonical([
      'wallet-warmup-session-journal-v2',
      id,
      consentId,
      termsSha256,
      createdAt,
    ]),
  );
}
/** SELECT/replay only. Parent consent/source and captured event prefix are
 * immutable; pages are checked against that exact head. No runtime grant. */
export async function readWalletWarmupV2Journal(
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
    if (row.owner_id !== owner || row.id !== id) fail();
    uuid.parse(row.consent_id);
    uuid.parse(row.review_id);
    hash.parse(row.terms_sha256);
    hash.parse(row.initial_sha256);
    iso.parse(row.created_at);
    z.number()
      .int()
      .min(0)
      .max(WARMUP_V2_JOURNAL_LIMITS.events)
      .parse(row.head_version);
    z.number()
      .int()
      .min(0)
      .max(WARMUP_V2_JOURNAL_LIMITS.bytes)
      .parse(row.document_bytes);
    hash.parse(row.head_sha256);
    iso.parse(row.head_updated_at);
    const consent = await readWalletWarmupV2Consent(
      db,
      owner,
      row.consent_id,
      signal,
    );
    if (
      !consent ||
      consent.termsSha256 !== row.terms_sha256 ||
      consent.terms.reviewId !== row.review_id ||
      row.created_at < consent.createdAt
    )
      fail();
    if (Date.parse(row.created_at) > now)
      fail(
        'Saved history is ahead of this server clock. Recover the same ID shortly.',
        409,
      );
    // readWalletWarmupV2Consent already reconstructs this exact manifest from its
    // original private source. No mutable sequence or raw source is made public.
    const manifest = JSON.parse(consent.terms.reviewDocument) as Omit<
      WalletWarmupSessionReview,
      'contextKey'
    >;
    const records = z
      .array(
        z
          .object({
            id: uuid,
            version: z.number().int(),
            previous_sha256: hash,
            document: z.string().max(2048),
            event_sha256: hash,
            created_at: iso,
          })
          .strict(),
      )
      .max(WARMUP_V2_JOURNAL_LIMITS.events)
      .parse(
        await readPrefix(db, owner, id, row.head_version, signal),
      ) as EventRow[];
    if (records.length !== row.head_version) fail();
    let head = await initial(
        row.id,
        row.consent_id,
        row.terms_sha256,
        row.created_at,
      ),
      last = row.created_at,
      bytes = 0,
      paused = false,
      stopped = false,
      pending: string | null = null;
    if (head !== row.initial_sha256) fail();
    const ids = new Set<string>(),
      finish = Date.parse(consent.terms.sessionExpiresAt),
      first = manifest.actions[0];
    for (const [index, record] of records.entries()) {
      signal.throwIfAborted();
      const event = eventSchema.parse(JSON.parse(record.document));
      const size = new TextEncoder().encode(record.document).byteLength;
      if (
        ids.has(record.id) ||
        record.version !== index + 1 ||
        event.eventId !== record.id ||
        event.version !== record.version ||
        event.previousSha256 !== head ||
        record.previous_sha256 !== head ||
        event.at !== record.created_at ||
        event.at < last ||
        record.document !== canonical(event) ||
        !warmupV2JournalControlFits(index, bytes, size, event.operation) ||
        stopped
      )
        fail();
      if (Date.parse(event.at) > now)
        fail(
          'Saved history is ahead of this server clock. Recover the same ID shortly.',
          409,
        );
      if (event.operation !== 'stop' && Date.parse(event.at) >= finish) fail();
      switch (event.operation) {
        case 'begin-review':
          if (
            paused ||
            pending ||
            event.actionId !== first.id ||
            Date.parse(event.at) < Date.parse(first.scheduledAt) ||
            (first.side === 'Sell' && first.source.kind !== 'saved-buy')
          )
            fail();
          pending = first.id;
          break;
        case 'pause':
          if (paused) fail();
          paused = true;
          break;
        case 'resume':
          if (!paused) fail();
          paused = false;
          break;
        case 'stop':
          stopped = true;
          break;
      }
      head = await digest(record.document);
      if (head !== record.event_sha256) fail();
      ids.add(record.id);
      bytes += size;
      last = event.at;
    }
    signal.throwIfAborted();
    if (
      head !== row.head_sha256 ||
      bytes !== row.document_bytes ||
      last !== row.head_updated_at
    )
      fail();
    const expired = now >= finish;
    const phase = stopped
      ? 'stopped'
      : expired
        ? 'expired'
        : paused
          ? 'paused'
          : pending
            ? 'reviewing'
            : now < Date.parse(first.scheduledAt)
              ? 'waiting'
              : 'review-required';
    return {
      id: row.id,
      consentId: row.consent_id,
      termsSha256: row.terms_sha256,
      createdAt: row.created_at,
      version: row.head_version,
      headSha256: head,
      documentBytes: bytes,
      updatedAt: last,
      consent,
      manifest,
      events: records,
      snapshot: {
        phase,
        paused,
        stopped,
        expired,
        pendingReview: pending ? first : null,
        totalActions: manifest.actions.length,
        completedActions: 0 as const,
      },
      executionAllowed: false as const,
      signingAllowed: false as const,
      automaticExecutionAllowed: false as const,
      qualificationAvailable: false as const,
    };
  } catch (error) {
    signal.throwIfAborted();
    if (
      error instanceof WalletWarmupV2JournalError &&
      (error.status === 503 ||
        error.message.startsWith('Saved history is ahead'))
    )
      throw error;
    fail(
      'Saved versioned history is incomplete or differs. No action was renewed.',
      503,
    );
  }
}
/** Recording passive history neither starts a session nor reserves funds. */
export async function retainWalletWarmupV2Journal(
  db: D1Database,
  owner: string,
  value: unknown,
  recordRequested: boolean,
  signal: AbortSignal,
  now: () => number = Date.now,
) {
  ownerId(owner);
  const input = rootInput.parse(value);
  if (recordRequested !== true)
    fail('Recording history requires an explicit request.', 400);
  const prior = await readWalletWarmupV2Journal(
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
  const consent = await readWalletWarmupV2Consent(
    db,
    owner,
    input.consentId,
    signal,
  );
  if (!consent || consent.termsSha256 !== input.termsSha256)
    fail('Choose the exact owned versioned approval.', 404);
  const createdAt = clock(now());
  if (createdAt < consent.createdAt) fail();
  const sha = await initial(
    input.id,
    input.consentId,
    input.termsSha256,
    createdAt,
  );
  signal.throwIfAborted();
  if (clock(now()) < createdAt) fail();
  try {
    await db
      .prepare(
        'INSERT INTO wallet_warmup_session_journals_v2 VALUES(?,?,?,?,?,?,?)',
      )
      .bind(
        owner,
        input.id,
        input.consentId,
        consent.terms.reviewId,
        input.termsSha256,
        sha,
        createdAt,
      )
      .run();
  } catch {
    /* Recover, never retry a write. */
  }
  const recovery = AbortSignal.timeout(15000),
    saved = await readWalletWarmupV2Journal(
      db,
      owner,
      input.id,
      recovery,
      now(),
    );
  if (saved) {
    if (
      saved.consentId !== input.consentId ||
      saved.termsSha256 !== input.termsSha256
    )
      fail();
    signal.throwIfAborted();
    return saved;
  }
  const existing = await db
    .prepare(
      'SELECT id FROM wallet_warmup_session_journals_v2 WHERE owner_id=? AND consent_id=? AND id<>?',
    )
    .bind(owner, input.consentId, input.id)
    .first<{ id: string }>();
  if (existing && uuid.safeParse(existing.id).success) {
    const old = await readWalletWarmupV2Journal(
      db,
      owner,
      existing.id,
      recovery,
      now(),
    );
    if (old)
      throw new WalletWarmupV2JournalError(
        'This approval already has history. Recover its original ID.',
        409,
        old.id,
      );
  }
  fail(
    'History could not be confirmed. Recover the same request ID before another write.',
  );
}
export async function appendWalletWarmupV2Journal(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
  now: () => number = Date.now,
) {
  ownerId(owner);
  const input = controlInput.parse(value),
    current = await readWalletWarmupV2Journal(
      db,
      owner,
      input.journalId,
      signal,
      now(),
    );
  if (!current) fail('Recover the owned history first.', 404);
  const prior = current.events.find((e) => e.id === input.id);
  if (prior) {
    const e = eventSchema.parse(JSON.parse(prior.document));
    if (
      e.operation !== input.control ||
      e.version !== input.version + 1 ||
      e.previousSha256 !== input.headSha256
    )
      fail();
    return current;
  }
  if (
    current.version !== input.version ||
    current.headSha256 !== input.headSha256
  )
    fail('The saved head changed. Refresh history before another control.');
  const s = current.snapshot;
  if (
    s.stopped ||
    (input.control === 'pause' && s.paused) ||
    (input.control === 'resume' && !s.paused) ||
    (input.control === 'begin-review' &&
      (s.paused || s.pendingReview || s.phase !== 'review-required')) ||
    (input.control !== 'stop' && s.expired)
  )
    fail('This control is unavailable in the saved session state.');
  const action = current.manifest.actions[0];
  if (
    input.control === 'begin-review' &&
    action.side === 'Sell' &&
    action.source.kind !== 'saved-buy'
  )
    fail('Recover the original buy receipt before reviewing this Sell.');
  const at = clock(now()),
    document = canonical({
      format: 'wallet-warmup-session-event-v2',
      eventId: input.id,
      version: current.version + 1,
      previousSha256: current.headSha256,
      at,
      operation: input.control,
      ...(input.control === 'begin-review' ? { actionId: action.id } : {}),
    });
  const size = new TextEncoder().encode(document).byteLength;
  if (
    !warmupV2JournalControlFits(
      current.version,
      current.documentBytes,
      size,
      input.control,
    )
  )
    fail(
      'History capacity is reached. Stop remains available before any new review.',
    );
  const sha = await digest(document),
    writeAt = clock(now());
  if (
    at < current.updatedAt ||
    writeAt < at ||
    (input.control !== 'stop' &&
      writeAt >= current.consent.terms.sessionExpiresAt)
  )
    fail('Approved session has finished. Recover its history.');
  signal.throwIfAborted();
  try {
    await db
      .prepare(
        'INSERT INTO wallet_warmup_session_journal_events_v2 VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        owner,
        input.journalId,
        input.id,
        current.version + 1,
        current.headSha256,
        document,
        sha,
        at,
      )
      .run();
  } catch {
    /* Original-ID readback is authoritative, not a transport reply. */
  }
  const saved = await readWalletWarmupV2Journal(
    db,
    owner,
    input.journalId,
    AbortSignal.timeout(15000),
    now(),
  );
  const recorded = saved?.events.find((e) => e.id === input.id);
  if (
    !saved ||
    !recorded ||
    recorded.document !== document ||
    recorded.event_sha256 !== sha
  )
    fail(
      'Control could not be confirmed. Recover its original ID; nothing is retried automatically.',
    );
  signal.throwIfAborted();
  return saved;
}
/** Explicit allowlist; no original source, event vector, packet or mutable state. */
export function publicWalletWarmupV2Journal(
  journal: NonNullable<Awaited<ReturnType<typeof readWalletWarmupV2Journal>>>,
  eventId?: string,
) {
  const event = eventId
    ? journal.events.find((e) => e.id === eventId)
    : undefined;
  const receipt = event ? eventSchema.parse(JSON.parse(event.document)) : null;
  const pending = journal.snapshot.pendingReview;
  return {
    format: 'wallet-warmup-session-journal-v2' as const,
    id: journal.id,
    consentId: journal.consentId,
    termsSha256: journal.termsSha256,
    createdAt: journal.createdAt,
    version: journal.version,
    headSha256: journal.headSha256,
    updatedAt: journal.updatedAt,
    sessionExpiresAt: journal.consent.terms.sessionExpiresAt,
    planId: journal.manifest.planId,
    planRevision: journal.manifest.planRevision,
    snapshot: {
      phase: journal.snapshot.phase,
      paused: journal.snapshot.paused,
      stopped: journal.snapshot.stopped,
      expired: journal.snapshot.expired,
      totalActions: journal.snapshot.totalActions,
      completedActions: journal.snapshot.completedActions,
      pendingReview: pending
        ? {
            id: pending.id,
            wallet: pending.wallet,
            walletRevision: pending.walletRevision,
            cycle: pending.cycle,
            side: pending.side,
            mint: pending.mint,
            scheduledAt: pending.scheduledAt,
          }
        : null,
    },
    wallets: journal.manifest.wallets.map((w) => ({
      wallet: w.wallet,
      reviewedBuySpendLamports: w.buySpendLamports,
      reviewedFeeReserveLamports: w.remainingFeeReserveLamports,
    })),
    commandReceipt: receipt
      ? {
          id: receipt.eventId,
          operation: receipt.operation,
          version: receipt.version,
          previousSha256: receipt.previousSha256,
          headSha256: event!.event_sha256,
          at: receipt.at,
          ...(receipt.operation === 'begin-review'
            ? { actionId: receipt.actionId }
            : {}),
        }
      : null,
    executionAllowed: false as const,
    signingAllowed: false as const,
    automaticExecutionAllowed: false as const,
    qualificationAvailable: false as const,
    limitations:
      'Saved plan history and review-slot metadata only. No fresh provider qualification, funds reservation, signing or automatic activity is enabled.',
  };
}
