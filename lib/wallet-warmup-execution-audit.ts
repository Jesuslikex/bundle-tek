import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { readWarmupExecutionRootBinding } from './wallet-warmup-execution-terms';
import {
  WarmupExecutionLedger,
  parseWarmupExecutionLedgerEvent,
} from './wallet-warmup-execution-ledger';
import {
  warmupExecutionHash as hash,
  warmupExecutionId as uuid,
  warmupExecutionTimestamp as iso,
  WARMUP_EXECUTION_POLICY,
} from './wallet-warmup-execution-manifest';

export const WARMUP_EXECUTION_EVENT_BYTES = 1536;
// Covers every one of the existing model's 76,100 bounded frames, without truncation.
export const WARMUP_EXECUTION_AUDIT_BYTES = 128 * 1024 * 1024;
export const WARMUP_EXECUTION_PROJECTION_BYTES = 32 * 1024 * 1024;
export const WARMUP_EXECUTION_CHECKPOINT_BYTES = 65536;
const encoder = new TextEncoder();
const eventFormat = 'wallet-warmup-execution-event-v1' as const;
const bodySchema = z
  .object({
    format: z.literal(eventFormat),
    rootId: uuid,
    rootSha256: hash,
    manifestSha256: hash,
    sequence: z.number().int().min(1).max(WARMUP_EXECUTION_POLICY.modelSteps),
    previousSha256: hash,
    event: z.unknown(),
  })
  .strict();
const entrySchema = bodySchema.extend({ sha256: hash }).strict();
const headSchema = z
  .object({
    rootId: uuid,
    rootSha256: hash,
    manifestSha256: hash,
    createdAt: iso,
    version: z.number().int().min(0).max(WARMUP_EXECUTION_POLICY.modelSteps),
    eventSha256: hash,
    checkpointSha256: hash,
  })
  .strict();
type Head = z.infer<typeof headSchema>;
type Selector = Parameters<typeof readWarmupExecutionRootBinding>[2];
type Context = Pick<
  Head,
  'rootId' | 'rootSha256' | 'manifestSha256' | 'createdAt'
>;
const authority = {
  receiptEvidenceVerified: false as const,
  currentSourceVerified: false as const,
  currentHeadVerified: false as const,
  financialReservationVerified: false as const,
  signingAllowed: false as const,
  executionAllowed: false as const,
  automaticExecutionAllowed: false as const,
};
export class WarmupExecutionAuditError extends Error {
  constructor() {
    super(
      'Saved warmup execution audit is incomplete, changed or unavailable. Recover the original owned head; no execution is authorized.',
    );
  }
}
function fail(): never {
  throw new WarmupExecutionAuditError();
}
function body(value: unknown) {
  const parsed = bodySchema.parse(value),
    event = parseWarmupExecutionLedgerEvent(parsed.event);
  // The model's expectedRootSha256 identifies the flat manifest, not its outer root.
  if (
    event.expectedVersion !== parsed.sequence - 1 ||
    event.expectedRootSha256 !== parsed.manifestSha256
  )
    fail();
  return { ...parsed, event };
}
function boundedSize(text: string, limit: number) {
  // UTF-8 bytes cannot be fewer than UTF-16 code units. Refuse huge strings
  // before allocating their encoded copy.
  if (text.length > limit) fail();
  const size = encoder.encode(text).byteLength;
  if (size > limit) fail();
  return size;
}
function bounded(text: string, limit: number) {
  boundedSize(text, limit);
  return text;
}
/** Serialization only. Computing a digest does not verify an event or receipt. */
export async function bindWarmupExecutionAuditEvent(value: unknown) {
  try {
    const own = body(value),
      sha256 = await digest(canonical(own));
    return {
      wire: bounded(
        canonical({ ...own, sha256 }),
        WARMUP_EXECUTION_EVENT_BYTES,
      ),
      sha256,
      scope: 'event-serialization-only' as const,
      ...authority,
    };
  } catch {
    return fail();
  }
}
async function genesis(context: Context) {
  return digest(
    canonical({ format: 'wallet-warmup-execution-genesis-v1', ...context }),
  );
}
async function boundContext(
  rawRoot: unknown,
  rawApproval: unknown,
  selector: Selector,
  context: Context,
) {
  const bound = await readWarmupExecutionRootBinding(
    rawRoot,
    rawApproval,
    selector,
  );
  if (
    context.rootId !== bound.root.terms.intent.id ||
    context.rootSha256 !== bound.rootSha256 ||
    context.manifestSha256 !== bound.manifestSha256 ||
    context.createdAt < bound.approval.approvedAt ||
    context.createdAt >= bound.manifest.expiresAt
  )
    fail();
  return bound;
}
function projection(
  context: Context,
  ledger: WarmupExecutionLedger,
  lots: Set<string>,
  receipts: string[],
  time: number,
) {
  return {
    format: 'wallet-warmup-execution-projection-v1' as const,
    ...context,
    // Historical replay time, never a current RPC Clock or fresh authority.
    modelTime: time,
    snapshot: ledger.snapshot(time),
    lots: [...lots].map((id) => ledger.lot(id, time) ?? fail()),
    outcomes: receipts.map((id) => ledger.outcome(id) ?? fail()),
    scope: 'bookkeeping-prefix-audit-only' as const,
    ...authority,
  };
}
function checkpoint(view: ReturnType<typeof projection>) {
  // Only a full-prefix audit summary. The snapshot omits reducer uniqueness
  // sets and complete lot balances: never restore it or append from it.
  return {
    format: 'wallet-warmup-execution-audit-summary-v1' as const,
    scope: 'audit-summary-not-resumable' as const,
    resumable: false as const,
    rootId: view.rootId,
    rootSha256: view.rootSha256,
    manifestSha256: view.manifestSha256,
    createdAt: view.createdAt,
    modelTime: view.modelTime,
    // Top-level rootSha256 is the outer approval root. The model snapshot's
    // legacy rootSha256 name denotes manifestSha256 instead.
    snapshot: structuredClone(view.snapshot),
  };
}
async function checkpointHash(view: ReturnType<typeof projection>) {
  // Per-wallet aggregates and the one pending action only; no growing history arrays.
  return digest(
    bounded(canonical(checkpoint(view)), WARMUP_EXECUTION_CHECKPOINT_BYTES),
  );
}
/** The creation timestamp must be the independently retained SQL timestamp.
 * This function cannot establish that provenance or create a database head.
 * A real caller-owned AbortSignal is required; cancellation retains its reason. */
export async function warmupExecutionAuditGenesis(
  rawRoot: unknown,
  rawApproval: unknown,
  selector: Selector,
  createdAt: string,
  signal: AbortSignal,
) {
  try {
    signal.throwIfAborted();
    createdAt = iso.parse(createdAt);
    // Root binding snapshots all mutable selectors/material before its first await.
    const bound = await readWarmupExecutionRootBinding(
      rawRoot,
      rawApproval,
      selector,
    );
    signal.throwIfAborted();
    const context = {
      rootId: bound.root.terms.intent.id,
      rootSha256: bound.rootSha256,
      manifestSha256: bound.manifestSha256,
      createdAt,
    };
    if (
      createdAt < bound.approval.approvedAt ||
      createdAt >= bound.manifest.expiresAt
    )
      fail();
    const ledger = await WarmupExecutionLedger.create(bound.manifest);
    const view = projection(
      context,
      ledger,
      new Set(bound.manifest.savedLots.map((l) => l.receiptId)),
      [],
      Date.parse(createdAt),
    );
    const head: Head = {
      ...context,
      version: 0,
      eventSha256: await genesis(context),
      checkpointSha256: await checkpointHash(view),
    };
    bounded(canonical(view), WARMUP_EXECUTION_PROJECTION_BYTES);
    signal.throwIfAborted();
    return {
      head,
      checkpoint: checkpoint(view),
      projection: view,
      scope: 'genesis-serialization-only' as const,
      ...authority,
    };
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}
async function next(
  iterator: AsyncIterator<unknown> | Iterator<unknown>,
  signal: AbortSignal,
): Promise<IteratorResult<unknown>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return iterator.next();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', stop));
  });
}
/** Full saved-prefix recovery/audit only, not the fast ordinary-append path.
 * Selector and head must be independently loaded from authenticated owned storage,
 * never derived from the stream or trusted because their hashes are self-consistent.
 * Streams are admitted one immutable bounded string at a time; no partial audit is
 * published. Opaque receipt/evidence hashes remain unverified bookkeeping inputs.
 * The returned checkpoint is a non-resumable summary, not reducer/CAS state.
 * A real caller-owned AbortSignal is required; cancellation retains its reason.
 * No database, provider, signer, timer or send callback is invoked. */
async function replayOwnedPrefix(
  rawRoot: unknown,
  rawApproval: unknown,
  selector: Selector,
  rawHead: unknown,
  stream: AsyncIterable<unknown> | Iterable<unknown>,
  signal: AbortSignal,
  controlOnly: boolean,
) {
  let iterator: AsyncIterator<unknown> | Iterator<unknown> | undefined,
    finished = false;
  try {
    signal.throwIfAborted();
    const head = headSchema.parse(rawHead);
    const { rootId, rootSha256, manifestSha256, createdAt } = head,
      context = { rootId, rootSha256, manifestSha256, createdAt };
    const bound = await boundContext(rawRoot, rawApproval, selector, context);
    signal.throwIfAborted();
    const ledger = await WarmupExecutionLedger.create(bound.manifest),
      lots = new Set(bound.manifest.savedLots.map((l) => l.receiptId)),
      receipts: string[] = [];
    let prior = await genesis(context),
      count = 0,
      bytes = 0,
      time = Date.parse(createdAt);
    iterator =
      Symbol.asyncIterator in stream
        ? stream[Symbol.asyncIterator]()
        : stream[Symbol.iterator]();
    for (;;) {
      const row = await next(iterator, signal);
      signal.throwIfAborted();
      if (row.done) {
        finished = true;
        break;
      }
      if (count >= head.version) fail();
      const value = row.value;
      if (typeof value !== 'string') fail();
      const wire = value;
      bytes += boundedSize(wire, WARMUP_EXECUTION_EVENT_BYTES);
      if (bytes > WARMUP_EXECUTION_AUDIT_BYTES) fail();
      const raw = JSON.parse(wire),
        { sha256, ...rest } = entrySchema.parse(raw),
        entry = body(rest);
      if (
        controlOnly &&
        !['pause', 'resume', 'stop'].includes(entry.event.operation)
      )
        fail();
      if (
        canonical({ ...entry, sha256 }) !== wire ||
        entry.rootId !== rootId ||
        entry.rootSha256 !== rootSha256 ||
        entry.manifestSha256 !== manifestSha256 ||
        entry.sequence !== count + 1 ||
        entry.previousSha256 !== prior ||
        entry.event.now < time ||
        sha256 !== (await digest(canonical(entry)))
      )
        fail();
      signal.throwIfAborted();
      ledger.apply(entry.event);
      time = entry.event.now;
      if (entry.event.operation === 'settle') {
        const outcome = ledger.outcome(entry.event.receiptId) ?? fail();
        receipts.push(outcome.receiptId);
        if (outcome.disposition === 'applied' && outcome.side === 'Buy')
          lots.add(outcome.receiptId);
      }
      prior = sha256;
      count++;
    }
    if (count !== head.version || prior !== head.eventSha256) fail();
    const view = projection(context, ledger, lots, receipts, time),
      sha256 = await checkpointHash(view);
    signal.throwIfAborted();
    if (sha256 !== head.checkpointSha256) fail();
    bounded(canonical(view), WARMUP_EXECUTION_PROJECTION_BYTES);
    return {
      // The complete reducer remains private. Its summary is never used to
      // restore hidden uniqueness, custody or lot state for a later transition.
      ledger,
      lots,
      receipts,
      context,
      result: {
        head,
        checkpoint: checkpoint(view),
        projection: view,
        replayedEvents: count,
        wireBytes: bytes,
        scope: 'bookkeeping-prefix-audit-only' as const,
        ...authority,
      },
    };
  } catch {
    signal.throwIfAborted();
    return fail();
  } finally {
    if (!finished && iterator) {
      const ownedIterator = iterator;
      // Keep receiver binding for both iterator types. Getter/method failures
      // are also caught; best-effort cleanup cannot replace the audit refusal.
      void Promise.resolve()
        .then(() => ownedIterator.return?.())
        .catch(() => {});
    }
  }
}

/** Full-prefix audit with the original public result and stream semantics.
 * Neither the reconstructed reducer nor a resumable checkpoint is exported. */
export async function auditSavedWarmupExecutionPrefix(
  rawRoot: unknown,
  rawApproval: unknown,
  selector: Selector,
  rawHead: unknown,
  stream: AsyncIterable<unknown> | Iterable<unknown>,
  signal: AbortSignal,
) {
  return (
    await replayOwnedPrefix(
      rawRoot,
      rawApproval,
      selector,
      rawHead,
      stream,
      signal,
      false,
    )
  ).result;
}

const controlSchema = z
  .object({
    operation: z.enum(['pause', 'resume', 'stop']),
    now: z
      .number()
      .int()
      .min(0)
      .max(8640000000000000 - 60000),
  })
  .strict();

/** Derive ONE unsigned control from the complete independently selected prefix.
 * Control time must come from retained server SQL evidence in a future writer,
 * not a client clock. No storage, current-head CAS, worker control or release is
 * performed here. Both proposed and historical financial events are refused.
 * All evidence, source, reservation, signing and execution authority stays false. */
export async function deriveWarmupExecutionControlAppend(
  rawRoot: unknown,
  rawApproval: unknown,
  selector: Selector,
  rawHead: unknown,
  stream: AsyncIterable<unknown> | Iterable<unknown>,
  value: unknown,
  signal: AbortSignal,
) {
  try {
    signal.throwIfAborted();
    // Capture the caller's operation/time before the asynchronous replay begins.
    const control = controlSchema.parse(value);
    const replay = await replayOwnedPrefix(
      rawRoot,
      rawApproval,
      selector,
      rawHead,
      stream,
      signal,
      true,
    );
    signal.throwIfAborted();
    const previousHead = replay.result.head;
    // A version-zero replay has not applied an event to the reducer. Its
    // private clock can predate the independently retained audit/lease time.
    if (control.now < replay.result.projection.modelTime) fail();
    const event = parseWarmupExecutionLedgerEvent({
      ...control,
      expectedRootSha256: previousHead.manifestSha256,
      expectedVersion: previousHead.version,
    });
    replay.ledger.apply(event);
    const bound = await bindWarmupExecutionAuditEvent({
      format: eventFormat,
      rootId: previousHead.rootId,
      rootSha256: previousHead.rootSha256,
      manifestSha256: previousHead.manifestSha256,
      sequence: previousHead.version + 1,
      previousSha256: previousHead.eventSha256,
      event,
    });
    signal.throwIfAborted();
    if (
      replay.result.wireBytes +
        boundedSize(bound.wire, WARMUP_EXECUTION_EVENT_BYTES) >
      WARMUP_EXECUTION_AUDIT_BYTES
    )
      fail();
    const view = projection(
      replay.context,
      replay.ledger,
      replay.lots,
      replay.receipts,
      control.now,
    );
    bounded(canonical(view), WARMUP_EXECUTION_PROJECTION_BYTES);
    const head: Head = {
      ...previousHead,
      version: previousHead.version + 1,
      eventSha256: bound.sha256,
      checkpointSha256: await checkpointHash(view),
    };
    signal.throwIfAborted();
    return {
      wire: bound.wire,
      head,
      checkpoint: checkpoint(view),
      projection: view,
      previousHead,
      replayedEvents: replay.result.replayedEvents,
      wireBytes: replay.result.wireBytes,
      scope: 'control-append-derivation-only' as const,
      ...authority,
    };
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}
