import { z } from 'zod';
import { admitWarmupConsentManifest } from './wallet-warmup-session-consent-view';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import {
  walletWarmupSessionView,
  type WalletWarmupSessionView,
} from './wallet-warmup-session-view';
import type { SavedWarmup } from './wallet-warmup-storage';
import type { RetainedWarmupSessionSummary } from './wallet-warmup-session-retained-view';
const uuid = z.uuid().refine((v) => v === v.toLowerCase()),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  iso = z.iso.datetime().refine((v) => new Date(v).toISOString() === v),
  units = z.string().regex(/^(0|[1-9]\d{0,21})$/);
export const warmupV2ClientControl = z.enum([
  'begin-review',
  'pause',
  'resume',
  'stop',
]);
const flags = {
  executionAllowed: z.literal(false),
  signingAllowed: z.literal(false),
  automaticExecutionAllowed: z.literal(false),
};
const policy = z
  .object({
    qualificationTtlMs: z.literal(60000),
    minimumGapMs: z.literal(30000),
    maxAttemptsPerAction: z.literal(3),
    maxPendingActions: z.literal(1),
    maxQualifications: z.number().int().min(3).max(14400),
  })
  .strict();
const terms = z
  .object({
    reviewId: uuid,
    reviewSha256: hash,
    sessionExpiresAt: iso,
    format: z.literal('wallet-warmup-session-consent-v2'),
    reviewDocument: z.string().max(1048576),
    policy,
    ...flags,
  })
  .strict();
const common = { terms, termsSha256: hash, reviewCreatedAt: iso };
const preview = z
  .object({
    consentReview: z
      .object({ ...common, reviewedAt: iso, reviewExpiresAt: iso })
      .strict(),
  })
  .strict();
const saved = z
  .object({
    consent: z.object({ ...common, id: uuid, createdAt: iso }).strict(),
  })
  .strict();
export const warmupV2ClientCanonical = (value: unknown) =>
  JSON.stringify(value, (_key, node: unknown) =>
    node && typeof node === 'object' && !Array.isArray(node)
      ? Object.fromEntries(
          Object.entries(node).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : node,
  );
const fail = (): never => {
  throw Error(
    'Saved session response differs. Recover the original IDs before another change.',
  );
};
const bounded = (value: unknown) => {
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    3 * 1024 * 1024
  )
    fail();
};
async function admit(
  record:
    | z.infer<typeof preview>['consentReview']
    | z.infer<typeof saved>['consent'],
  planId: string,
  original?: WalletWarmupSessionView['review'],
) {
  if (
    new TextEncoder().encode(record.terms.reviewDocument).byteLength >
      1048576 ||
    (await digest(warmupV2ClientCanonical(record.terms))) !== record.termsSha256
  )
    fail();
  const checked = await admitWarmupConsentManifest(record, planId, original);
  if (record.terms.policy.maxQualifications !== checked.summary.actionCount * 3)
    fail();
  return { ...record, ...checked };
}
export async function warmupV2Preview(
  value: unknown,
  plan: SavedWarmup,
  view: WalletWarmupSessionView,
  retained: RetainedWarmupSessionSummary,
  finish: string,
  now = Date.now(),
) {
  bounded(value);
  const record = preview.parse(value).consentReview;
  const current = walletWarmupSessionView(
    { review: view.review, reviewExpiresAt: view.reviewExpiresAt },
    plan,
    now,
  );
  const checked = await admit(record, plan.id, current.review);
  if (
    plan.archived ||
    record.terms.reviewId !== retained.id ||
    record.terms.reviewSha256 !== retained.reviewSha256 ||
    record.reviewCreatedAt !== retained.createdAt ||
    record.reviewedAt !== retained.reviewedAt ||
    checked.summary.planRevision !== plan.revision ||
    record.terms.sessionExpiresAt !== finish
  )
    fail();
  return {
    ...checked,
    terms: record.terms,
    reviewedAt: record.reviewedAt,
    reviewExpiresAt: record.reviewExpiresAt,
    deadline: Math.min(
      view.deadline,
      current.deadline,
      Date.parse(record.reviewExpiresAt),
    ),
  };
}
export type WarmupV2Preview = Awaited<ReturnType<typeof warmupV2Preview>>;
export async function warmupV2Saved(
  value: unknown,
  expected: {
    id: string;
    planId: string;
    termsSha256?: string;
    reviewId?: string;
    reviewSha256?: string;
  },
) {
  bounded(value);
  const record = saved.parse(value).consent;
  if (
    record.id !== expected.id ||
    (expected.termsSha256 && record.termsSha256 !== expected.termsSha256) ||
    (expected.reviewId && record.terms.reviewId !== expected.reviewId) ||
    (expected.reviewSha256 &&
      record.terms.reviewSha256 !== expected.reviewSha256)
  )
    fail();
  return {
    ...(await admit(record, expected.planId)),
    id: record.id,
    createdAt: record.createdAt,
    terms: record.terms,
  };
}
export type WarmupV2Saved = Awaited<ReturnType<typeof warmupV2Saved>>;
const action = z
  .object({
    id: z.string().min(1).max(256),
    wallet: z.string().min(32).max(44),
    walletRevision: z.number().int().positive(),
    cycle: z.number().int().min(1).max(20),
    side: z.enum(['Buy', 'Sell']),
    mint: z.string().min(32).max(44),
    scheduledAt: iso,
  })
  .strict();
const receipt = z
  .object({
    id: uuid,
    operation: warmupV2ClientControl,
    version: z.number().int().min(1).max(65536),
    previousSha256: hash,
    headSha256: hash,
    at: iso,
    actionId: z.string().min(1).max(256).optional(),
  })
  .strict();
const journalSchema = z
  .object({
    journal: z
      .object({
        format: z.literal('wallet-warmup-session-journal-v2'),
        id: uuid,
        consentId: uuid,
        termsSha256: hash,
        createdAt: iso,
        version: z.number().int().min(0).max(65536),
        headSha256: hash,
        updatedAt: iso,
        sessionExpiresAt: iso,
        planId: z.string().min(1).max(64),
        planRevision: z.number().int().positive(),
        snapshot: z
          .object({
            phase: z.enum([
              'stopped',
              'expired',
              'paused',
              'reviewing',
              'waiting',
              'review-required',
            ]),
            paused: z.boolean(),
            stopped: z.boolean(),
            expired: z.boolean(),
            totalActions: z.number().int().min(1).max(4800),
            completedActions: z.literal(0),
            pendingReview: action.nullable(),
          })
          .strict(),
        wallets: z
          .array(
            z
              .object({
                wallet: z.string().min(32).max(44),
                reviewedBuySpendLamports: units,
                reviewedFeeReserveLamports: units,
              })
              .strict(),
          )
          .min(1)
          .max(20),
        commandReceipt: receipt.nullable(),
        ...flags,
        qualificationAvailable: z.literal(false),
        limitations: z.literal(
          'Saved plan history and review-slot metadata only. No fresh provider qualification, funds reservation, signing or automatic activity is enabled.',
        ),
      })
      .strict(),
  })
  .strict();
const recordRequest = z
  .object({ kind: z.literal('record'), id: uuid })
  .strict();
const controlRequest = z
  .object({
    kind: z.literal('control'),
    id: uuid,
    journalId: uuid,
    version: z.number().int().min(0).max(65535),
    headSha256: hash,
    control: warmupV2ClientControl,
  })
  .strict();
const consentRequest = z
  .object({
    kind: z.literal('consent'),
    id: uuid,
    reviewId: uuid,
    reviewSha256: hash,
    sessionExpiresAt: iso,
  })
  .strict();
const reminder = z
  .object({
    format: z.literal('wallet-warmup-v2-reminder-v1'),
    planId: z.string().min(1).max(64),
    consentId: uuid,
    termsSha256: hash,
    journalId: uuid.nullable(),
    request: z
      .union([recordRequest, controlRequest, consentRequest])
      .nullable(),
    stopRequest: controlRequest
      .extend({ control: z.literal('stop') })
      .optional(),
  })
  .strict();
export type WarmupV2Reminder = z.infer<typeof reminder>;
export function warmupV2Reminder(value: unknown, planId: string) {
  bounded(value);
  const result = reminder.parse(value);
  if (
    result.planId !== planId ||
    (result.request?.kind === 'consent' &&
      result.request.id !== result.consentId) ||
    (result.request?.kind === 'control' &&
      result.request.journalId !== result.journalId) ||
    (result.request?.kind === 'record' && result.journalId !== null)
  )
    fail();
  if (
    result.stopRequest &&
    (!result.request ||
      result.request.kind !== 'control' ||
      result.stopRequest.id === result.request.id ||
      result.stopRequest.journalId !== result.request.journalId ||
      result.stopRequest.version !== result.request.version ||
      result.stopRequest.headSha256 !== result.request.headSha256)
  )
    fail();
  return result;
}
export async function warmupV2Journal(
  value: unknown,
  consent: WarmupV2Saved,
  expected: {
    id: string;
    request?: WarmupV2Reminder['request'];
    previous?: WarmupV2Journal;
  },
) {
  bounded(value);
  const j = journalSchema.parse(value).journal,
    manifest = JSON.parse(
      consent.terms.reviewDocument,
    ) as WalletWarmupSessionView['review'];
  if (
    j.id !== expected.id ||
    j.consentId !== consent.id ||
    j.termsSha256 !== consent.termsSha256 ||
    j.planId !== manifest.planId ||
    j.planRevision !== manifest.planRevision ||
    j.createdAt < consent.createdAt ||
    j.updatedAt < j.createdAt ||
    j.sessionExpiresAt !== consent.terms.sessionExpiresAt ||
    j.snapshot.totalActions !== manifest.actions.length
  )
    fail();
  const wallets = manifest.wallets.map((w) => ({
    wallet: w.wallet,
    reviewedBuySpendLamports: w.buySpendLamports,
    reviewedFeeReserveLamports: w.remainingFeeReserveLamports,
  }));
  if (warmupV2ClientCanonical(wallets) !== warmupV2ClientCanonical(j.wallets))
    fail();
  const first = manifest.actions[0],
    pending = j.snapshot.pendingReview;
  if (
    pending &&
    warmupV2ClientCanonical(pending) !==
      warmupV2ClientCanonical({
        id: first.id,
        wallet: first.wallet,
        walletRevision: first.walletRevision,
        cycle: first.cycle,
        side: first.side,
        mint: first.mint,
        scheduledAt: first.scheduledAt,
      })
  )
    fail();
  const s = j.snapshot;
  const phase = s.stopped
    ? 'stopped'
    : s.expired
      ? 'expired'
      : s.paused
        ? 'paused'
        : pending
          ? 'reviewing'
          : null;
  if (
    phase
      ? s.phase !== phase
      : !['waiting', 'review-required'].includes(s.phase)
  )
    fail();
  if (
    j.version === 0 &&
    (j.commandReceipt ||
      pending ||
      s.stopped ||
      s.paused ||
      j.updatedAt !== j.createdAt ||
      j.headSha256 !==
        (await digest(
          warmupV2ClientCanonical([
            'wallet-warmup-session-journal-v2',
            j.id,
            j.consentId,
            j.termsSha256,
            j.createdAt,
          ]),
        )))
  )
    fail();
  if (
    expected.previous &&
    (j.id !== expected.previous.id ||
      j.createdAt !== expected.previous.createdAt ||
      j.version < expected.previous.version ||
      (j.version === expected.previous.version &&
        j.headSha256 !== expected.previous.headSha256) ||
      (expected.previous.snapshot.stopped && !s.stopped))
  )
    fail();
  const command = expected.request;
  if (command?.kind === 'record' && command.id !== j.id) fail();
  if (command?.kind === 'control') {
    const r = j.commandReceipt;
    if (
      !r ||
      r.id !== command.id ||
      r.operation !== command.control ||
      r.version !== command.version + 1 ||
      r.previousSha256 !== command.headSha256 ||
      r.version > j.version ||
      r.at > j.updatedAt ||
      (r.operation === 'begin-review'
        ? r.actionId !== first.id
        : r.actionId !== undefined)
    )
      fail();
  }
  if (j.commandReceipt) {
    const r = j.commandReceipt;
    if (
      (r.operation === 'stop' && !s.stopped) ||
      (r.operation === 'begin-review' && !pending) ||
      (pending && pending.scheduledAt > j.updatedAt) ||
      (r.version === j.version &&
        ((r.operation === 'pause' && !s.paused) ||
          (r.operation === 'resume' && s.paused) ||
          (r.operation !== 'stop' && s.stopped)))
    )
      fail();
    if (
      r.version > j.version ||
      r.at < j.createdAt ||
      r.at > j.updatedAt ||
      (r.operation === 'begin-review'
        ? r.actionId !== first.id
        : r.actionId !== undefined)
    )
      fail();
    const document = {
      format: 'wallet-warmup-session-event-v2',
      eventId: r.id,
      version: r.version,
      previousSha256: r.previousSha256,
      at: r.at,
      operation: r.operation,
      ...(r.operation === 'begin-review' ? { actionId: r.actionId } : {}),
    };
    if (
      (await digest(warmupV2ClientCanonical(document))) !== r.headSha256 ||
      (r.version === j.version && r.headSha256 !== j.headSha256)
    )
      fail();
  }
  return j;
}
export type WarmupV2Journal = z.infer<typeof journalSchema>['journal'];
/** A missing event is NOT enough to retire an uncertain write. Its exact
 * predecessor must already be consumed by a newer immutable head, so that a
 * delayed original INSERT can no longer win CAS. No retry or new consent. */
export async function warmupV2AbsentControl(
  value: unknown,
  consent: WarmupV2Saved,
  request: Extract<
    NonNullable<WarmupV2Reminder['request']>,
    { kind: 'control' }
  >,
  previous?: WarmupV2Journal,
) {
  const j = await warmupV2Journal(value, consent, {
    id: request.journalId,
    previous,
  });
  if (j.commandReceipt !== null || j.version <= request.version) fail();
  return j;
}
