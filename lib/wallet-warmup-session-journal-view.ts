import { z } from 'zod';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import type { warmupConsentSaved } from './wallet-warmup-session-consent-view';
export type WarmupJournalConsent = Awaited<
  ReturnType<typeof warmupConsentSaved>
>;
const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const iso = z.iso.datetime().refine((v) => new Date(v).toISOString() === v);
const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const units = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})$/)
  .refine((v) => BigInt(v) <= 20n * ((1n << 64n) - 1n));
const action = z
  .object({
    id: z.string().min(1).max(1024),
    side: z.enum(['Buy', 'Sell']),
    cycle: z.number().int().min(1).max(20),
    wallet: address,
    walletRevision: z.number().int().positive(),
    mint: address,
    scheduledAt: iso,
  })
  .strict();
const control = z.enum(['pause', 'resume', 'stop']);
const journalSchema = z
  .object({
    id: uuid,
    consentId: uuid,
    termsSha256: hash,
    createdAt: iso,
    sessionExpiresAt: iso,
    effectiveReviewExpiresAt: iso,
    version: z.number().int().min(0).max(4096),
    headSha256: hash,
    recoveryRequired: z.boolean(),
    snapshot: z
      .object({
        phase: z.enum([
          'recovery-required',
          'stopped',
          'in-flight',
          'complete',
          'paused',
          'refresh-required',
          'review-required',
          'waiting',
        ]),
        planId: z.string().min(1).max(64),
        planRevision: z.number().int().positive(),
        sourceReviewFresh: z.boolean(),
        sourceReviewExpiresAt: iso,
        completedActions: z.number().int().min(0).max(800),
        totalActions: z.number().int().min(1).max(800),
        nextReviewAt: iso.nullable(),
        reviewWindowUnavailable: z.boolean(),
        paused: z.boolean(),
        stopped: z.boolean(),
        pending: z
          .object({
            state: z.enum(['reviewing', 'submitted', 'unknown']),
            action,
          })
          .strict()
          .nullable(),
        wallets: z
          .array(
            z
              .object({
                wallet: address,
                recordedFurtherBuySpendLamports: units,
                recordedFurtherFeeRentLamports: units,
                remainingReserveLamports: units,
              })
              .strict(),
          )
          .min(1)
          .max(20),
      })
      .strict(),
    commandReceipt: z
      .object({
        id: uuid,
        operation: control,
        actionId: z.null(),
        version: z.number().int().min(1).max(4096),
        headSha256: hash,
        at: iso,
      })
      .strict()
      .nullable(),
    executionAllowed: z.literal(false),
    signingAllowed: z.literal(false),
    automaticExecutionAllowed: z.literal(false),
  })
  .strict();
export type WarmupJournalView = z.infer<typeof journalSchema>;
const markerBase = {
  format: z.literal('warmup-journal-request-v1'),
  consentId: uuid,
  termsSha256: hash,
  id: uuid,
};
const markerSchema = z.discriminatedUnion('kind', [
  z.object({ ...markerBase, kind: z.literal('record') }).strict(),
  z
    .object({
      ...markerBase,
      kind: z.literal('control'),
      journalId: uuid,
      control,
      expectedVersion: z.number().int().min(0).max(4095),
      expectedHeadSha256: hash,
    })
    .strict(),
]);
export type WarmupJournalRequest = z.infer<typeof markerSchema>;
function fail(): never {
  throw Error(
    'Saved session status is unavailable or differs from this approval. Refresh saved status before another change.',
  );
}
const manifest = z
  .object({
    planId: z.string(),
    planRevision: z.number().int().positive(),
    actions: z.array(action.loose()).min(1).max(800),
    wallets: z
      .array(
        z
          .object({
            wallet: address,
            buySpendLamports: units,
            remainingFeeReserveLamports: units,
          })
          .loose(),
      )
      .min(1)
      .max(20),
  })
  .loose();
export function warmupJournalContext(consent: WarmupJournalConsent) {
  const source = manifest.parse(JSON.parse(consent.terms.reviewDocument));
  if (
    source.planId !== consent.summary.planId ||
    source.planRevision !== consent.summary.planRevision ||
    source.actions.length !== consent.summary.actionCount ||
    source.wallets.length !== consent.summary.walletCount ||
    new Set(source.wallets.map((w) => w.wallet)).size !==
      source.wallets.length ||
    new Set(source.actions.map((a) => a.id)).size !== source.actions.length
  )
    fail();
  return {
    ...source,
    consentId: uuid.parse(consent.id),
    termsSha256: hash.parse(consent.termsSha256),
    createdAt: iso.parse(consent.createdAt),
    sessionExpiresAt: iso.parse(consent.terms.sessionExpiresAt),
    sourceReviewExpiresAt: iso.parse(consent.reviewExpiresAt),
  };
}
export type WarmupJournalContext = ReturnType<typeof warmupJournalContext>;
export function warmupJournalRequest(
  value: unknown,
  context: WarmupJournalContext,
) {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 2048)
      fail();
    const parsed = markerSchema.parse(value);
    if (
      parsed.consentId !== context.consentId ||
      parsed.termsSha256 !== context.termsSha256
    )
      fail();
    return parsed;
  } catch {
    return fail();
  }
}
export function warmupJournalRequestBody(request: WarmupJournalRequest) {
  return request.kind === 'record'
    ? {
        operation: 'record',
        id: request.id,
        consentId: request.consentId,
        termsSha256: request.termsSha256,
        recordRequested: true,
      }
    : {
        operation: 'control',
        id: request.id,
        journalId: request.journalId,
        expectedVersion: request.expectedVersion,
        expectedHeadSha256: request.expectedHeadSha256,
        control: request.control,
      };
}
/** Admit only an owned, explicitly non-authorizing projection for the original approval. */
export async function warmupJournalView(
  value: unknown,
  context: WarmupJournalContext,
  expected: {
    id?: string;
    request?: WarmupJournalRequest;
    requireReceipt?: boolean;
    previous?: WarmupJournalView;
  } = {},
) {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536)
      fail();
    const j = z
        .object({ journal: journalSchema })
        .strict()
        .parse(value).journal,
      s = j.snapshot;
    const deadline = new Date(
      Math.min(
        Date.parse(context.sourceReviewExpiresAt),
        Date.parse(context.sessionExpiresAt),
      ),
    ).toISOString();
    if (
      j.consentId !== context.consentId ||
      j.termsSha256 !== context.termsSha256 ||
      (expected.id && j.id !== expected.id) ||
      j.sessionExpiresAt !== context.sessionExpiresAt ||
      j.effectiveReviewExpiresAt !== deadline ||
      Date.parse(j.createdAt) < Date.parse(context.createdAt) ||
      s.planId !== context.planId ||
      s.planRevision !== context.planRevision ||
      s.sourceReviewExpiresAt !== context.sourceReviewExpiresAt ||
      s.totalActions !== context.actions.length ||
      s.completedActions > s.totalActions ||
      s.completedActions > j.version ||
      j.recoveryRequired !== (s.pending !== null)
    )
      fail();
    const wallets = new Map(context.wallets.map((w) => [w.wallet, w]));
    const previous = expected.previous;
    if (
      previous &&
      (j.id !== previous.id ||
        j.version < previous.version ||
        (j.version === previous.version &&
          j.headSha256 !== previous.headSha256) ||
        s.completedActions < previous.snapshot.completedActions ||
        (previous.snapshot.stopped && !s.stopped))
    )
      fail();
    if (
      s.wallets.length !== wallets.size ||
      new Set(s.wallets.map((w) => w.wallet)).size !== s.wallets.length
    )
      fail();
    for (const w of s.wallets) {
      const original = wallets.get(w.wallet);
      if (
        !original ||
        BigInt(w.recordedFurtherBuySpendLamports) >
          BigInt(original.buySpendLamports) ||
        BigInt(w.recordedFurtherFeeRentLamports) +
          BigInt(w.remainingReserveLamports) !==
          BigInt(original.remainingFeeReserveLamports)
      )
        fail();
      const earlier = previous?.snapshot.wallets.find(
        (p) => p.wallet === w.wallet,
      );
      if (
        earlier &&
        (BigInt(w.recordedFurtherBuySpendLamports) <
          BigInt(earlier.recordedFurtherBuySpendLamports) ||
          BigInt(w.recordedFurtherFeeRentLamports) <
            BigInt(earlier.recordedFurtherFeeRentLamports) ||
          BigInt(w.remainingReserveLamports) >
            BigInt(earlier.remainingReserveLamports))
      )
        fail();
      if (
        j.version === 0 &&
        (w.recordedFurtherBuySpendLamports !== '0' ||
          w.recordedFurtherFeeRentLamports !== '0')
      )
        fail();
    }
    if (s.pending) {
      const original = context.actions.find(
        (a) => a.id === s.pending!.action.id,
      );
      if (
        !original ||
        Object.entries(s.pending.action).some(
          ([key, item]) => original[key as keyof typeof original] !== item,
        )
      )
        fail();
    }
    if (
      j.version === 0 &&
      (s.pending || s.paused || s.stopped || s.completedActions)
    )
      fail();
    if (s.reviewWindowUnavailable && s.nextReviewAt !== null) fail();
    if (
      s.nextReviewAt !== null &&
      Date.parse(s.nextReviewAt) >= Date.parse(deadline)
    )
      fail();
    const phase =
      s.pending?.state === 'unknown'
        ? 'recovery-required'
        : s.stopped
          ? 'stopped'
          : s.pending
            ? 'in-flight'
            : s.completedActions === s.totalActions
              ? 'complete'
              : s.paused
                ? 'paused'
                : !s.sourceReviewFresh || s.reviewWindowUnavailable
                  ? 'refresh-required'
                  : null;
    if (
      phase
        ? s.phase !== phase
        : !['waiting', 'review-required'].includes(s.phase)
    )
      fail();
    const request = expected.request
      ? warmupJournalRequest(expected.request, context)
      : undefined;
    if (request?.kind === 'control') {
      if (j.id !== request.journalId) fail();
      const receipt = j.commandReceipt;
      if (expected.requireReceipt && !receipt) fail();
      if (
        receipt &&
        (receipt.id !== request.id ||
          receipt.operation !== request.control ||
          receipt.version !== request.expectedVersion + 1 ||
          receipt.version > j.version ||
          Date.parse(receipt.at) < Date.parse(j.createdAt) ||
          (receipt.version === j.version &&
            receipt.headSha256 !== j.headSha256))
      )
        fail();
      if (
        receipt &&
        (await digest(
          JSON.stringify({
            at: receipt.at,
            eventId: request.id,
            operation: request.control,
            previousSha256: request.expectedHeadSha256,
            version: receipt.version,
          }),
        )) !== receipt.headSha256
      )
        fail();
    } else if (j.commandReceipt !== null) fail();
    return j;
  } catch {
    return fail();
  }
}
/** Bounded UTF-8 JSON, never expose an upstream HTML/parser/provider message. */
export async function readWarmupJournalResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
      'application/json' ||
    Number(response.headers.get('content-length') ?? 0) > 65536
  ) {
    void response.body?.cancel().catch(() => {});
    fail();
  }
  const reader = response.body?.getReader();
  if (!reader) fail();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '',
      bytes = 0;
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 65536) fail();
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch {
    signal.throwIfAborted();
    return fail();
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
