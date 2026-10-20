import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { loadWalletWarmupProgress } from './wallet-warmup-progress-server';
import { reviewWalletWarmupSession } from './wallet-warmup-session-review';
import { warmupCycleProgress } from './warmup-cycle-progress';
import {
  warmupLotPerformance,
  type PerformanceBuy,
  type PerformanceSell,
} from './warmup-lot-performance';
import type { SavedWarmup } from './wallet-warmup-storage';
import { UUID } from './wallet-operation';
import {
  walletWarmupSessionDigest as digest,
  WARMUP_SESSION_REVIEW_FORMAT,
  WARMUP_SESSION_SOURCE_FORMAT,
  WARMUP_SESSION_DOCUMENT_BYTES,
  WARMUP_SESSION_SOURCE_BYTES,
  WARMUP_SESSION_ROW_BYTES,
} from './wallet-warmup-session-digest';

export class WalletWarmupSessionStorageError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
type Row = {
  owner_id: string;
  id: string;
  plan_id: string;
  plan_revision: number;
  review_sha256: string;
  source_sha256: string;
  document: string;
  source: string;
  reviewed_at: string;
  review_expires_at: string;
  created_at: string;
};
type Source = Awaited<ReturnType<typeof loadWalletWarmupProgress>>['source'];
export type WarmupSessionReviewSelection = {
  id: string;
  planId: string;
  revision: number;
  reviewedAt: string;
  reviewSha256: string;
};
const fail = (message: string, status = 409): never => {
  throw new WalletWarmupSessionStorageError(message, status);
};
function capacity(document: string, source: string) {
  const docBytes = new TextEncoder().encode(document).byteLength,
    sourceBytes = new TextEncoder().encode(source).byteLength;
  if (
    docBytes > WARMUP_SESSION_DOCUMENT_BYTES ||
    sourceBytes > WARMUP_SESSION_SOURCE_BYTES ||
    docBytes + sourceBytes > WARMUP_SESSION_ROW_BYTES
  )
    fail(
      'This review exceeds retained snapshot capacity. Complete or recover existing lots manually before reviewing a smaller session.',
    );
}
async function installed(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('wallet_warmup_session_reviews_insert','wallet_warmup_session_reviews_no_update','wallet_warmup_session_reviews_no_delete')",
    )
    .first<{ n: number }>();
  if (row?.n !== 3)
    fail('Warmup session review storage is not installed.', 503);
}
function selection(value: WarmupSessionReviewSelection) {
  if (
    !value ||
    !UUID.test(value.id) ||
    value.id !== value.id.toLowerCase() ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(value.planId) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    value.revision >= 1000000000 ||
    !/^[a-f0-9]{64}$/.test(value.reviewSha256) ||
    !Number.isFinite(Date.parse(value.reviewedAt)) ||
    new Date(value.reviewedAt).toISOString() !== value.reviewedAt
  )
    fail('Choose the exact current session review.', 400);
  return structuredClone(value);
}
async function decode(row: Row) {
  capacity(row.document, row.source);
  if (
    !UUID.test(row.id) ||
    !/^[a-f0-9]{64}$/.test(row.review_sha256) ||
    !/^[a-f0-9]{64}$/.test(row.source_sha256) ||
    (await digest(row.source)) !== row.source_sha256
  )
    fail('Retained session review evidence differs.', 503);
  const source = JSON.parse(row.source) as Source;
  if (
    source.format !== WARMUP_SESSION_SOURCE_FORMAT ||
    !Array.isArray(source.buys) ||
    !Array.isArray(source.sells)
  )
    fail('Retained session review source is unavailable.', 503);
  const plan: SavedWarmup = {
    id: row.plan_id,
    revision: row.plan_revision,
    archived: false,
    updatedAt: source.planUpdatedAt,
    document: JSON.parse(source.planDocument),
  };
  const buys = source.buys.map((value) => ({
    ...(value as Record<string, unknown>),
    document: JSON.parse((value as Record<string, unknown>).document as string),
  })) as PerformanceBuy[];
  const sells = source.sells.map((value) => ({
    ...(value as Record<string, unknown>),
    document: JSON.parse((value as Record<string, unknown>).document as string),
  })) as PerformanceSell[];
  const progress = warmupCycleProgress(plan, buys, sells, [], false),
    performance = warmupLotPerformance(
      buys,
      sells,
      progress.steps.flatMap((step) => step.buyIds),
    );
  const reviewedAt = Date.parse(row.reviewed_at),
    expiresAt = Date.parse(row.review_expires_at),
    createdAt = Date.parse(row.created_at);
  if (
    !Number.isSafeInteger(reviewedAt) ||
    expiresAt - reviewedAt !== 60000 ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < reviewedAt ||
    createdAt > expiresAt
  )
    fail('Retained session review lifetime differs.', 503);
  const rebuilt = reviewWalletWarmupSession(
      plan,
      progress,
      performance,
      reviewedAt,
    ),
    { contextKey, ...manifest } = rebuilt;
  const expected = {
    format: WARMUP_SESSION_REVIEW_FORMAT,
    contextSha256: row.review_sha256,
    sourceSha256: row.source_sha256,
    ...manifest,
  };
  if (
    (await digest(contextKey)) !== row.review_sha256 ||
    canonical(JSON.parse(row.document)) !== canonical(expected)
  )
    fail('Retained session review document differs.', 503);
  return {
    id: row.id,
    planId: row.plan_id,
    planRevision: row.plan_revision,
    reviewSha256: row.review_sha256,
    reviewedAt: row.reviewed_at,
    reviewExpiresAt: row.review_expires_at,
    createdAt: row.created_at,
    document: manifest,
  };
}
async function read(db: D1Database, owner: string, id: string) {
  const row = await db
    .prepare(
      'SELECT * FROM wallet_warmup_session_reviews WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<Row>();
  if (!row) return null;
  try {
    return await decode(row);
  } catch {
    return fail(
      'Retained session review evidence is unavailable or differs.',
      503,
    );
  }
}
export async function readWalletWarmupSessionReview(
  db: D1Database,
  owner: string,
  id: string,
) {
  if (!UUID.test(id)) fail('Choose a retained session review.', 400);
  await installed(db);
  return read(db, owner, id);
}
export async function retainWalletWarmupSessionReview(
  db: D1Database,
  owner: string,
  request: WarmupSessionReviewSelection,
  saveRequested: boolean,
  signal: AbortSignal,
  clock: () => number = Date.now,
) {
  if (saveRequested !== true)
    fail('Saving this exact review requires an explicit request.', 400);
  const input = selection(request);
  signal.throwIfAborted();
  await installed(db);
  signal.throwIfAborted();
  const prior = await read(db, owner, input.id);
  signal.throwIfAborted();
  if (prior) {
    if (
      prior.planId !== input.planId ||
      prior.planRevision !== input.revision ||
      prior.reviewedAt !== input.reviewedAt ||
      prior.reviewSha256 !== input.reviewSha256
    )
      fail('This review id already belongs to different retained contents.');
    return prior;
  }
  const at = Date.parse(input.reviewedAt),
    now = clock();
  if (!Number.isSafeInteger(now) || at > now || now - at >= 60000)
    fail('The session review expired. Request a fresh review.');
  const current = await loadWalletWarmupProgress(
    db,
    owner,
    input.planId,
    input.revision,
    false,
    true,
  );
  signal.throwIfAborted();
  const reviewed = reviewWalletWarmupSession(
      current.plan,
      current.progress,
      current.performance,
      at,
    ),
    reviewSha256 = await digest(reviewed.contextKey);
  signal.throwIfAborted();
  if (reviewSha256 !== input.reviewSha256)
    fail(
      'The session review or recorded receipts changed. Request a fresh review.',
    );
  const source = canonical(current.source),
    sourceSha256 = await digest(source),
    { contextKey: _contextKey, ...manifest } = reviewed;
  const document = canonical({
    format: WARMUP_SESSION_REVIEW_FORMAT,
    contextSha256: reviewSha256,
    sourceSha256,
    ...manifest,
  });
  capacity(document, source);
  signal.throwIfAborted();
  const createdAt = new Date(clock()).toISOString(),
    expiresAt = new Date(at + 60000).toISOString();
  if (Date.parse(createdAt) < at || Date.parse(createdAt) >= at + 60000)
    fail('The session review expired. Request a fresh review.');
  try {
    await db
      .prepare(
        'INSERT INTO wallet_warmup_session_reviews(owner_id,id,plan_id,plan_revision,review_sha256,source_sha256,document,source,reviewed_at,review_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        owner,
        input.id,
        input.planId,
        input.revision,
        reviewSha256,
        sourceSha256,
        document,
        source,
        input.reviewedAt,
        expiresAt,
        createdAt,
      )
      .run();
  } catch (error) {
    // A lost response must never cause a replacement write. Recover only this exact identity.
    const existing = await read(db, owner, input.id);
    if (
      existing &&
      existing.reviewSha256 === reviewSha256 &&
      existing.planId === input.planId &&
      existing.planRevision === input.revision
    )
      return existing;
    const text = error instanceof Error ? error.message : '';
    fail(
      /constraint|Warmup session|Invalid warmup|UNIQUE/i.test(text)
        ? 'The review was already retained or its plan, wallet or receipt baseline changed. Recover the original review or request a fresh one.'
        : 'Review save outcome is unknown. Recover this exact review id before retrying.',
      /constraint|Warmup session|Invalid warmup|UNIQUE/i.test(text) ? 409 : 503,
    );
  }
  const retained = await read(db, owner, input.id);
  if (!retained)
    return fail(
      'Review save outcome is unknown. Recover this exact review id before retrying.',
      503,
    );
  return retained;
}
export type RetainedWalletWarmupSessionReview = NonNullable<
  Awaited<ReturnType<typeof readWalletWarmupSessionReview>>
>;
