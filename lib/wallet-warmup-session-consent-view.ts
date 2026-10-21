import { z } from 'zod';
import type { SavedWarmup } from './wallet-warmup-storage';
import {
  walletWarmupSessionView,
  type WalletWarmupSessionView,
} from './wallet-warmup-session-view';
import {
  walletWarmupSessionRetainedView,
  type RetainedWarmupSessionSummary,
} from './wallet-warmup-session-retained-view';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const iso = z.iso.datetime().refine((v) => new Date(v).toISOString() === v);
const terms = z
  .object({
    reviewId: uuid,
    reviewSha256: hash,
    sessionExpiresAt: iso,
    format: z.literal('wallet-warmup-session-consent-v1'),
    reviewDocument: z.string().max(1048576),
    executionAllowed: z.literal(false),
    signingAllowed: z.literal(false),
    automaticExecutionAllowed: z.literal(false),
  })
  .strict();
const marker = z
  .object({
    id: uuid,
    planId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
    reviewId: uuid,
    reviewSha256: hash,
    sessionExpiresAt: iso,
    termsSha256: hash,
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
export type WarmupConsentRecovery = z.infer<typeof marker>;
export class WarmupConsentConflictError extends Error {
  constructor(readonly recoveryId: string) {
    super(
      'This review already has a saved plan approval. Recover its original approval ID.',
    );
  }
}
export function warmupConsentConflict(value: unknown) {
  const parsed = z
    .object({
      error: z.literal(
        'This review already has a saved plan approval. Recover its original approval ID.',
      ),
      recoveryId: uuid,
    })
    .strict()
    .safeParse(value);
  return parsed.success
    ? new WarmupConsentConflictError(parsed.data.recoveryId)
    : null;
}
export const WARMUP_CONSENT_FINISH_MINUTES = [1, 3, 5] as const;
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, node: unknown) =>
    node && typeof node === 'object' && !Array.isArray(node)
      ? Object.fromEntries(
          Object.entries(node).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : node,
  );
function fail(): never {
  throw Error(
    'Plan approval response differs. Recover its original ID before another save.',
  );
}
function size(value: unknown) {
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    3 * 1024 * 1024
  )
    fail();
}
export function warmupConsentRecovery(value: unknown, planId: string) {
  const result = marker.parse(value);
  if (result.planId !== planId) fail();
  return result;
}
async function admit(
  record:
    | z.infer<typeof preview>['consentReview']
    | z.infer<typeof saved>['consent'],
  planId: string,
  original?: WalletWarmupSessionView['review'],
) {
  if ((await digest(canonical(record.terms))) !== record.termsSha256) fail();
  const root: unknown = JSON.parse(record.terms.reviewDocument);
  if (!root || typeof root !== 'object' || Array.isArray(root)) fail();
  const { format, contextSha256, sourceSha256, ...document } = root as Record<
    string,
    unknown
  >;
  if (
    format !== 'wallet-warmup-session-review-v1' ||
    contextSha256 !== record.terms.reviewSha256 ||
    typeof sourceSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sourceSha256)
  )
    fail();
  const keys = [
    'planId',
    'planRevision',
    'reviewedAt',
    'originalStartAt',
    'effectiveStartAt',
    'actions',
    'wallets',
    'totalMaximumNativeSpendLamports',
    'completedRecordedLoops',
    'status',
    'executionAllowed',
    'signingAllowed',
    'automaticExecutionAllowed',
  ];
  if (
    Object.keys(document).length !== keys.length ||
    Object.keys(document).some((k) => !keys.includes(k)) ||
    document.status !== 'Review required' ||
    !Number.isInteger(document.completedRecordedLoops) ||
    Number(document.completedRecordedLoops) < 0 ||
    Number(document.completedRecordedLoops) > 400
  )
    fail();
  const reviewedAt = iso.parse(document.reviewedAt);
  iso.parse(document.originalStartAt);
  iso.parse(document.effectiveStartAt);
  const expires = new Date(Date.parse(reviewedAt) + 60000).toISOString();
  if (
    'reviewedAt' in record &&
    (record.reviewedAt !== reviewedAt || record.reviewExpiresAt !== expires)
  )
    fail();
  if (
    'createdAt' in record &&
    (Date.parse(record.createdAt) < Date.parse(reviewedAt) ||
      Date.parse(record.createdAt) >= Date.parse(expires) ||
      Date.parse(record.createdAt) >= Date.parse(record.terms.sessionExpiresAt))
  )
    fail();
  const summary = await walletWarmupSessionRetainedView(
    {
      retainedReview: {
        id: record.terms.reviewId,
        planId: document.planId,
        planRevision: document.planRevision,
        reviewSha256: record.terms.reviewSha256,
        reviewedAt,
        reviewExpiresAt: expires,
        createdAt: record.reviewCreatedAt,
        document,
      },
    },
    { id: record.terms.reviewId, planId },
    original,
  );
  if (!Array.isArray(document.actions) || !document.actions.length) fail();
  const latest = Math.max(
    ...document.actions.map((a: Record<string, unknown>) =>
      Date.parse(iso.parse(a.scheduledAt)),
    ),
  );
  const end = Date.parse(record.terms.sessionExpiresAt);
  if (end <= latest || end > latest + 5 * 60 * 1000) fail();
  return { summary, reviewedAt, reviewExpiresAt: expires };
}
export async function warmupConsentPreview(
  value: unknown,
  plan: SavedWarmup,
  view: WalletWarmupSessionView,
  retained: RetainedWarmupSessionSummary,
  deadline: string,
  now = Date.now(),
) {
  try {
    size(value);
    const record = preview.parse(value).consentReview;
    const current = walletWarmupSessionView(
      { review: view.review, reviewExpiresAt: view.reviewExpiresAt },
      plan,
      now,
    );
    const checked = await admit(record, plan.id, current.review);
    if (
      record.terms.sessionExpiresAt !== deadline ||
      record.terms.reviewId !== retained.id ||
      record.terms.reviewSha256 !== retained.reviewSha256 ||
      record.reviewCreatedAt !== retained.createdAt ||
      checked.summary.planRevision !== plan.revision ||
      checked.reviewedAt !== retained.reviewedAt
    )
      fail();
    return {
      ...record,
      ...checked,
      deadline: Math.min(
        view.deadline,
        current.deadline,
        Date.parse(record.reviewExpiresAt),
      ),
    };
  } catch {
    return fail();
  }
}
export type WarmupConsentPreview = Awaited<
  ReturnType<typeof warmupConsentPreview>
>;
/** Re-admit the original context and lifetime immediately before retaining a save identity. */
export async function warmupConsentSaveSelection(
  prepared: WarmupConsentPreview,
  plan: SavedWarmup,
  view: WalletWarmupSessionView,
  retained: RetainedWarmupSessionSummary,
  selectedDeadline: string,
  clock: () => number = Date.now,
): Promise<WarmupConsentRecovery> {
  const checked = await warmupConsentPreview(
    {
      consentReview: {
        terms: prepared.terms,
        termsSha256: prepared.termsSha256,
        reviewCreatedAt: prepared.reviewCreatedAt,
        reviewedAt: prepared.reviewedAt,
        reviewExpiresAt: prepared.reviewExpiresAt,
      },
    },
    plan,
    view,
    retained,
    selectedDeadline,
    clock(),
  );
  const now = clock();
  if (
    !Number.isSafeInteger(now) ||
    now >= Math.min(prepared.deadline, checked.deadline)
  )
    fail();
  return {
    id: crypto.randomUUID(),
    planId: plan.id,
    reviewId: retained.id,
    reviewSha256: retained.reviewSha256,
    sessionExpiresAt: checked.terms.sessionExpiresAt,
    termsSha256: checked.termsSha256,
  };
}
export async function warmupConsentSaved(
  value: unknown,
  expected: { id: string; planId: string } & Partial<
    Omit<WarmupConsentRecovery, 'id' | 'planId'>
  >,
  original?: WalletWarmupSessionView['review'],
) {
  try {
    size(value);
    const record = saved.parse(value).consent;
    if (
      record.id !== expected.id ||
      Object.entries(expected).some(
        ([key, item]) =>
          key !== 'id' &&
          key !== 'planId' &&
          item !==
            (key === 'termsSha256'
              ? record.termsSha256
              : record.terms[key as keyof typeof record.terms]),
      )
    )
      fail();
    const checked = await admit(record, expected.planId, original);
    return { ...record, ...checked };
  } catch {
    return fail();
  }
}
/** Bound the response body and cancel stalled reads with the request's signal. */
export async function readWarmupConsentResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const limit = 3 * 1024 * 1024;
  if (
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
      'application/json' ||
    Number(response.headers.get('content-length') ?? 0) > limit
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
      if (bytes > limit) fail();
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch {
    signal.throwIfAborted();
    return fail();
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
