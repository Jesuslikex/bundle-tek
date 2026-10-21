import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import { readWalletWarmupSessionReview } from './wallet-warmup-session-storage';

const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Recorded consent ends at most five minutes after the last captured action. */
export const WARMUP_SESSION_DEADLINE_GRACE_MS = 5 * 60 * 1000;
const iso = z.iso.datetime().refine((v) => new Date(v).toISOString() === v);
const selection = z
  .object({
    reviewId: uuid,
    reviewSha256: hash,
    sessionExpiresAt: iso,
  })
  .strict();
const request = selection.extend({ id: uuid, termsSha256: hash }).strict();
const terms = selection
  .extend({
    format: z.literal('wallet-warmup-session-consent-v1'),
    reviewDocument: z.string().max(1048576),
    executionAllowed: z.literal(false),
    signingAllowed: z.literal(false),
    automaticExecutionAllowed: z.literal(false),
  })
  .strict();
type Selection = z.infer<typeof selection>;
type Row = {
  id: string;
  review_id: string;
  document: string;
  terms_sha256: string;
  created_at: string;
};
export class WalletWarmupSessionConsentError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly recoveryId?: string,
  ) {
    super(message);
  }
}
function fail(message: string, status = 409): never {
  throw new WalletWarmupSessionConsentError(message, status);
}
function ownerId(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    fail('Verified session owner required.', 400);
}
async function installed(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('wallet_warmup_session_consents_insert','wallet_warmup_session_consents_no_update','wallet_warmup_session_consents_no_delete','wallet_warmup_session_consents_bounds')",
    )
    .first<{ n: number }>();
  if (row?.n !== 4)
    fail('Warmup session consent storage is not installed.', 503);
}
async function build(
  db: D1Database,
  owner: string,
  input: Selection,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const rawRead = () =>
    db
      .prepare(
        'SELECT document,source,source_sha256 FROM wallet_warmup_session_reviews WHERE owner_id=? AND id=?',
      )
      .bind(owner, input.reviewId)
      .first<{ document: string; source: string; source_sha256: string }>();
  const row = await rawRead();
  signal.throwIfAborted();
  if (!row) fail('Choose the exact retained session review.');
  const retained = await readWalletWarmupSessionReview(
    db,
    owner,
    input.reviewId,
  );
  signal.throwIfAborted();
  if (!retained || retained.reviewSha256 !== input.reviewSha256)
    fail('Choose the exact retained session review.');
  if (!retained.document.actions.length)
    fail('This review has no remaining actions to approve.');
  const expiry = Date.parse(input.sessionExpiresAt);
  const lastActionAt = Math.max(
    ...retained.document.actions.map((a) => Date.parse(a.scheduledAt)),
  );
  if (
    retained.document.actions.some(
      (a) => Date.parse(a.scheduledAt) >= expiry,
    ) ||
    expiry <= Date.parse(retained.reviewedAt)
  )
    fail('The selected session deadline must follow every reviewed action.');
  if (expiry > lastActionAt + WARMUP_SESSION_DEADLINE_GRACE_MS)
    fail(
      'The session deadline cannot exceed five minutes after the last reviewed action.',
    );
  const after = await rawRead();
  signal.throwIfAborted();
  if (canonical(row) !== canonical(after))
    fail('Retained session review changed.');
  // Bind the exact originally checked raw document, not a new plan or rebased schedule.
  const raw = JSON.parse(row.document),
    { format, contextSha256, sourceSha256, ...manifest } = raw;
  if (
    format !== 'wallet-warmup-session-review-v1' ||
    contextSha256 !== retained.reviewSha256 ||
    !/^[a-f0-9]{64}$/.test(sourceSha256) ||
    canonical(manifest) !== canonical(retained.document)
  )
    fail('Retained session review changed.');
  const value = terms.parse({
    ...input,
    format: 'wallet-warmup-session-consent-v1',
    reviewDocument: row.document,
    executionAllowed: false,
    signingAllowed: false,
    automaticExecutionAllowed: false,
  });
  const document = canonical(value);
  if (new TextEncoder().encode(document).byteLength > 1572864)
    fail('Session consent exceeds retained capacity.');
  const termsSha256 = await digest(document);
  signal.throwIfAborted();
  return {
    terms: value,
    termsSha256,
    reviewExpiresAt: retained.reviewExpiresAt,
    reviewedAt: retained.reviewedAt,
  };
}
/** Historical terms reconstruction only; this never renews a review or saves consent. */
export { build as buildWalletWarmupSessionConsentTerms };
/** Internal only: the owner must come from a verified server session. No execution grant. */
export async function reviewWalletWarmupSessionConsent(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
  now = Date.now(),
) {
  ownerId(owner);
  const input = selection.parse(value);
  const result = await build(db, owner, input, signal);
  if (
    !Number.isSafeInteger(now) ||
    now < Date.parse(result.reviewedAt) ||
    now >= Date.parse(result.reviewExpiresAt) ||
    now >= Date.parse(input.sessionExpiresAt)
  )
    fail('The source review expired. Request a fresh review.');
  return result;
}
export async function readWalletWarmupSessionConsent(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  ownerId(owner);
  uuid.parse(id);
  signal.throwIfAborted();
  await installed(db);
  signal.throwIfAborted();
  const row = await db
    .prepare(
      'SELECT id,review_id,document,terms_sha256,created_at FROM wallet_warmup_session_consents WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<Row>();
  signal.throwIfAborted();
  if (!row) return null;
  try {
    if (new TextEncoder().encode(row.document).byteLength > 1572864)
      fail('Consent capacity differs.');
    const saved = terms.parse(JSON.parse(row.document));
    const rebuilt = await build(
      db,
      owner,
      selection.parse({
        reviewId: saved.reviewId,
        reviewSha256: saved.reviewSha256,
        sessionExpiresAt: saved.sessionExpiresAt,
      }),
      signal,
    );
    if (
      row.review_id !== saved.reviewId ||
      row.terms_sha256 !== rebuilt.termsSha256 ||
      canonical(saved) !== canonical(rebuilt.terms) ||
      row.document !== canonical(saved) ||
      !Number.isSafeInteger(Date.parse(row.created_at)) ||
      new Date(row.created_at).toISOString() !== row.created_at ||
      Date.parse(row.created_at) < Date.parse(rebuilt.reviewedAt) ||
      Date.parse(row.created_at) >= Date.parse(rebuilt.reviewExpiresAt) ||
      Date.parse(row.created_at) >= Date.parse(saved.sessionExpiresAt)
    )
      fail('Retained consent differs.');
    return {
      id: row.id,
      createdAt: row.created_at,
      termsSha256: row.terms_sha256,
      terms: saved,
    };
  } catch {
    signal.throwIfAborted();
    throw new WalletWarmupSessionConsentError(
      'Retained session consent is unavailable or differs.',
      503,
    );
  }
}
/** Explicit plan consent only. Fresh transaction authorization and durable execution are separate. */
export async function retainWalletWarmupSessionConsent(
  db: D1Database,
  owner: string,
  value: unknown,
  approved: boolean,
  signal: AbortSignal,
  clock: () => number = Date.now,
) {
  ownerId(owner);
  if (approved !== true)
    fail('Approve these exact session terms separately.', 400);
  const input = request.parse(value);
  signal.throwIfAborted();
  await installed(db);
  signal.throwIfAborted();
  const prior = await readWalletWarmupSessionConsent(
    db,
    owner,
    input.id,
    signal,
  );
  if (prior) {
    if (
      prior.termsSha256 !== input.termsSha256 ||
      prior.terms.reviewId !== input.reviewId ||
      prior.terms.reviewSha256 !== input.reviewSha256 ||
      prior.terms.sessionExpiresAt !== input.sessionExpiresAt
    )
      fail('This consent ID already belongs to different terms.');
    return prior;
  }
  const rebuilt = await reviewWalletWarmupSessionConsent(
    db,
    owner,
    selection.parse({
      reviewId: input.reviewId,
      reviewSha256: input.reviewSha256,
      sessionExpiresAt: input.sessionExpiresAt,
    }),
    signal,
    clock(),
  );
  if (rebuilt.termsSha256 !== input.termsSha256)
    fail('The session consent terms changed.');
  const at = clock();
  if (
    !Number.isSafeInteger(at) ||
    at < Date.parse(rebuilt.reviewedAt) ||
    at >= Date.parse(rebuilt.reviewExpiresAt) ||
    at >= Date.parse(input.sessionExpiresAt)
  )
    fail('The source review expired. Request a fresh review.');
  const createdAt = new Date(at).toISOString();
  signal.throwIfAborted();
  try {
    await db
      .prepare(
        'INSERT INTO wallet_warmup_session_consents(owner_id,id,review_id,terms_sha256,document,created_at) VALUES(?,?,?,?,?,?)',
      )
      .bind(
        owner,
        input.id,
        input.reviewId,
        input.termsSha256,
        canonical(rebuilt.terms),
        createdAt,
      )
      .run();
  } catch {
    // Recover only the same identity. No replacement write or automatic retry.
    const recovered = await readWalletWarmupSessionConsent(
      db,
      owner,
      input.id,
      AbortSignal.timeout(15000),
    );
    if (recovered && recovered.termsSha256 === input.termsSha256)
      return recovered;
    const existing = await db
      .prepare(
        'SELECT id FROM wallet_warmup_session_consents WHERE owner_id=? AND review_id=? AND id<>?',
      )
      .bind(owner, input.reviewId, input.id)
      .first<{ id: string }>();
    if (existing && uuid.safeParse(existing.id).success)
      throw new WalletWarmupSessionConsentError(
        'This review already has a saved plan approval. Recover its original approval ID.',
        409,
        existing.id,
      );
    fail(
      'Consent save was refused or its outcome is unknown. Recover the same consent ID before another attempt.',
    );
  }
  const saved = await readWalletWarmupSessionConsent(
    db,
    owner,
    input.id,
    AbortSignal.timeout(15000),
  );
  if (!saved)
    fail('Consent save outcome is unknown. Recover the same consent ID.', 503);
  return saved;
}
