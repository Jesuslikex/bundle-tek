import { z } from 'zod';
import type { SavedWarmup } from './wallet-warmup-storage';
import {
  WalletWarmupSessionSequence,
  WARMUP_SESSION_REVIEW_GAP_MS,
} from './wallet-warmup-session-sequence';
import { walletWarmupSessionDigest } from './wallet-warmup-session-digest';

const FORMAT = 'wallet-warmup-session-journal-v1';
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 4096;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().refine((value) => {
  const at = Date.parse(value);
  return Number.isSafeInteger(at) && new Date(at).toISOString() === value;
});
const anchorSchema = z
  .object({
    sourceSha256: digest,
    startedAt: timestamp,
    version: z.number().int().min(0).max(MAX_EVENTS),
    headSha256: digest,
  })
  .strict();
const base = z.object({
  // Durable writers bind their idempotency ID inside the hashed document.
  // Earlier internal (non-stored) journals did not carry this field.
  eventId: z
    .uuid()
    .refine((v) => v === v.toLowerCase())
    .optional(),
  version: z.number().int().min(1).max(MAX_EVENTS),
  previousSha256: digest,
  at: timestamp,
});
const actionId = z.string().min(1).max(1024);
const transition = z.discriminatedUnion('operation', [
  base.extend({ operation: z.literal('begin-review'), actionId }).strict(),
  base.extend({ operation: z.literal('submitted'), actionId }).strict(),
  base.extend({ operation: z.literal('unknown'), actionId }).strict(),
  base
    .extend({
      operation: z.literal('finalized'),
      actionId,
      settlement: z.record(z.string(), z.unknown()),
    })
    .strict(),
  base.extend({ operation: z.literal('pause') }).strict(),
  base.extend({ operation: z.literal('resume') }).strict(),
  base.extend({ operation: z.literal('stop') }).strict(),
]);
const fail = (): never => {
  throw Error(
    'Session journal is incomplete or changed. Recover its original records.',
  );
};

/**
 * Internal SELECT-result decoder only. The caller must obtain the source and
 * anchor from the same authenticated, atomic database snapshot, and independently
 * replay real finalized receipts. A hash chain proves neither ownership nor truth.
 * No mutable sequence, execution grant or replacement action is returned.
 */
export async function replayWalletWarmupSessionJournal(
  sourceDocument: string,
  plan: SavedWarmup,
  expected: unknown,
  documents: readonly string[],
  now = Date.now(),
) {
  try {
    const anchor = anchorSchema.parse(expected);
    const start = Date.parse(anchor.startedAt);
    if (
      !Number.isSafeInteger(now) ||
      now < start ||
      now > 8640000000000000 - WARMUP_SESSION_REVIEW_GAP_MS ||
      typeof sourceDocument !== 'string' ||
      !Array.isArray(documents) ||
      documents.length !== anchor.version ||
      documents.length > MAX_EVENTS
    )
      return fail();
    // Own all caller-controlled nested values before the first asynchronous hash.
    const records = [...documents];
    const capturedPlan = structuredClone(plan);
    let bytes = new TextEncoder().encode(sourceDocument).byteLength;
    if (bytes > MAX_BYTES) return fail();
    for (const document of records) {
      if (typeof document !== 'string') return fail();
      bytes += new TextEncoder().encode(document).byteLength;
      if (bytes > MAX_BYTES) return fail();
    }
    if (
      (await walletWarmupSessionDigest(sourceDocument)) !== anchor.sourceSha256
    )
      return fail();
    const source = JSON.parse(sourceDocument);
    if (start < Date.parse(source?.review?.reviewedAt)) return fail();
    const sequence = new WalletWarmupSessionSequence(
      source,
      capturedPlan,
      start,
    );
    let head = await walletWarmupSessionDigest(
      JSON.stringify([FORMAT, anchor.sourceSha256, anchor.startedAt]),
    );
    let clock = start;
    for (let index = 0; index < records.length; index++) {
      const document = records[index];
      const event = transition.parse(JSON.parse(document));
      const at = Date.parse(event.at);
      if (
        event.version !== index + 1 ||
        event.previousSha256 !== head ||
        at < clock ||
        at > now
      )
        return fail();
      clock = at;
      switch (event.operation) {
        case 'begin-review':
          if (sequence.beginReview(at).action.id !== event.actionId)
            return fail();
          break;
        case 'submitted':
          sequence.recordSubmission(event.actionId, at);
          break;
        case 'unknown':
          sequence.requireRecovery(event.actionId, at);
          break;
        case 'finalized':
          if (
            sequence.snapshot(at).pending?.action.id !== event.actionId ||
            event.settlement.actionId !== event.actionId
          )
            return fail();
          sequence.recordFinalized(event.settlement, at);
          break;
        case 'pause':
          sequence.pause(at);
          break;
        case 'resume':
          sequence.resume(at);
          break;
        case 'stop':
          sequence.stop(at);
          break;
      }
      head = await walletWarmupSessionDigest(document);
    }
    if (head !== anchor.headSha256) return fail();
    const snapshot = sequence.snapshot(now);
    return {
      version: anchor.version,
      headSha256: head,
      snapshot,
      // Even an abandoned review may have produced a late signing response.
      // Replaying its label must never make a replacement action available.
      recoveryRequired: snapshot.pending !== null,
      executionAllowed: false as const,
      signingAllowed: false as const,
      automaticExecutionAllowed: false as const,
    };
  } catch {
    return fail();
  }
}
