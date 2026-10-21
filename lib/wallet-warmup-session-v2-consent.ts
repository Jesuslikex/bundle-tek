import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import {
  buildWalletWarmupSessionConsentTerms,
  WalletWarmupSessionConsentError,
} from './wallet-warmup-session-consent';
import { WalletWarmupSessionStorageError } from './wallet-warmup-session-storage';

const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const iso = z.iso.datetime().refine((v) => new Date(v).toISOString() === v);
const selection = z
  .object({ reviewId: uuid, reviewSha256: hash, sessionExpiresAt: iso })
  .strict();
const request = selection.extend({ id: uuid, termsSha256: hash }).strict();
export const WARMUP_V2_POLICY = Object.freeze({
  qualificationTtlMs: 60000,
  minimumGapMs: 30000,
  maxAttemptsPerAction: 3,
  maxPendingActions: 1,
});
const termsSchema = selection
  .extend({
    format: z.literal('wallet-warmup-session-consent-v2'),
    reviewDocument: z.string().max(1048576),
    policy: z
      .object({
        qualificationTtlMs: z.literal(60000),
        minimumGapMs: z.literal(30000),
        maxAttemptsPerAction: z.literal(3),
        maxPendingActions: z.literal(1),
        maxQualifications: z.number().int().min(3).max(14400),
      })
      .strict(),
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
export class WalletWarmupV2ConsentError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly recoveryId?: string,
  ) {
    super(message);
  }
}
function fail(
  message = 'Versioned session approval differs. Recover its original ID.',
  status = 409,
): never {
  throw new WalletWarmupV2ConsentError(message, status);
}
function ownerId(owner: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(owner))
    fail('Verified owner required.', 400);
}
/** Count bound matches the retained-review format, not the legacy journal's 800. */
export function warmupV2QualificationPolicy(actionCount: number) {
  if (
    !Number.isSafeInteger(actionCount) ||
    actionCount < 1 ||
    actionCount > 4800
  )
    fail(
      'The remaining action count exceeds versioned approval capacity. No actions were dropped.',
    );
  return {
    ...WARMUP_V2_POLICY,
    maxQualifications: actionCount * WARMUP_V2_POLICY.maxAttemptsPerAction,
  };
}
async function refuseLegacyApproval(
  db: D1Database,
  owner: string,
  input: { reviewId: string; id?: string },
  signal: AbortSignal,
) {
  const legacy = await db
    .prepare(
      'SELECT id FROM wallet_warmup_session_consents WHERE owner_id=? AND (review_id=? OR id=?) LIMIT 1',
    )
    .bind(owner, input.reviewId, input.id ?? '')
    .first<{ id: string }>();
  signal.throwIfAborted();
  if (legacy)
    fail(
      'This review or request ID already has legacy approval. It is not upgraded. Recover that approval or request a new source review.',
    );
}
async function installed(db: D1Database) {
  const r = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('wallet_warmup_session_consents_v2_insert','wallet_warmup_session_consents_v2_no_update','wallet_warmup_session_consents_v2_no_delete','wallet_warmup_session_consents_v2_bounds','wallet_warmup_session_consents_v2_policy','wallet_warmup_session_consents_legacy_policy_isolation')",
    )
    .first<{ n: number }>();
  if (r?.n !== 6)
    fail('Versioned warmup approval storage is not installed.', 503);
}
async function build(
  db: D1Database,
  owner: string,
  input: Selection,
  signal: AbortSignal,
) {
  await refuseLegacyApproval(db, owner, input, signal);
  let legacy: Awaited<ReturnType<typeof buildWalletWarmupSessionConsentTerms>>;
  try {
    legacy = await buildWalletWarmupSessionConsentTerms(
      db,
      owner,
      input,
      signal,
    );
  } catch (error) {
    if (
      error instanceof WalletWarmupSessionConsentError ||
      error instanceof WalletWarmupSessionStorageError
    )
      throw new WalletWarmupV2ConsentError(error.message, error.status);
    throw error;
  }
  const manifest = JSON.parse(legacy.terms.reviewDocument);
  const count = z.array(z.unknown()).parse(manifest.actions).length;
  const terms = termsSchema.parse({
    ...legacy.terms,
    format: 'wallet-warmup-session-consent-v2',
    policy: warmupV2QualificationPolicy(count),
  });
  const document = canonical(terms);
  if (new TextEncoder().encode(document).byteLength > 1572864)
    fail(
      'Versioned approval exceeds retained capacity. Review a smaller plan before approving.',
    );
  const termsSha256 = await digest(document);
  signal.throwIfAborted();
  return {
    terms,
    termsSha256,
    reviewedAt: legacy.reviewedAt,
    reviewExpiresAt: legacy.reviewExpiresAt,
  };
}
export async function reviewWalletWarmupV2Consent(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
  now = Date.now(),
) {
  ownerId(owner);
  const input = selection.parse(value);
  signal.throwIfAborted();
  await installed(db);
  const result = await build(db, owner, input, signal);
  if (
    !Number.isSafeInteger(now) ||
    now < Date.parse(result.reviewedAt) ||
    now >= Date.parse(result.reviewExpiresAt) ||
    now >= Date.parse(input.sessionExpiresAt)
  )
    fail(
      'The initial source review expired. Request and approve a new review.',
    );
  return result;
}
/** Saved-only recovery: immutable records stay readable after expiry/archive. */
export async function readWalletWarmupV2Consent(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  ownerId(owner);
  uuid.parse(id);
  signal.throwIfAborted();
  await installed(db);
  const row = await db
    .prepare(
      'SELECT id,review_id,document,terms_sha256,created_at FROM wallet_warmup_session_consents_v2 WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<Row>();
  signal.throwIfAborted();
  if (!row) return null;
  try {
    if (new TextEncoder().encode(row.document).byteLength > 1572864) fail();
    const saved = termsSchema.parse(JSON.parse(row.document));
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
      row.id !== id ||
      row.review_id !== saved.reviewId ||
      row.document !== canonical(saved) ||
      row.document !== canonical(rebuilt.terms) ||
      row.terms_sha256 !== rebuilt.termsSha256 ||
      iso.parse(row.created_at) !== row.created_at ||
      Date.parse(row.created_at) < Date.parse(rebuilt.reviewedAt) ||
      Date.parse(row.created_at) >= Date.parse(rebuilt.reviewExpiresAt) ||
      Date.parse(row.created_at) >= Date.parse(saved.sessionExpiresAt)
    )
      fail();
    return {
      id: row.id,
      createdAt: row.created_at,
      termsSha256: row.terms_sha256,
      terms: saved,
    };
  } catch {
    signal.throwIfAborted();
    fail('Saved versioned approval is unavailable or differs.', 503);
  }
}
/** Explicit finite read-policy consent, never signature or transaction authority. */
export async function retainWalletWarmupV2Consent(
  db: D1Database,
  owner: string,
  value: unknown,
  approved: boolean,
  signal: AbortSignal,
  clock: () => number = Date.now,
) {
  ownerId(owner);
  const input = request.parse(value);
  if (approved !== true)
    fail('Approve these exact versioned terms separately.', 400);
  signal.throwIfAborted();
  const prior = await readWalletWarmupV2Consent(db, owner, input.id, signal);
  const matches = (
    saved: NonNullable<Awaited<ReturnType<typeof readWalletWarmupV2Consent>>>,
  ) =>
    saved.termsSha256 === input.termsSha256 &&
    saved.terms.reviewId === input.reviewId &&
    saved.terms.reviewSha256 === input.reviewSha256 &&
    saved.terms.sessionExpiresAt === input.sessionExpiresAt;
  if (prior) {
    if (!matches(prior)) fail();
    return prior;
  }
  await refuseLegacyApproval(db, owner, input, signal);
  await refuseExistingApproval(db, owner, input, signal);
  const rebuilt = await reviewWalletWarmupV2Consent(
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
    fail('The versioned terms changed. Review them again.');
  const at = clock();
  if (
    !Number.isSafeInteger(at) ||
    at < Date.parse(rebuilt.reviewedAt) ||
    at >= Date.parse(rebuilt.reviewExpiresAt) ||
    at >= Date.parse(input.sessionExpiresAt)
  )
    fail('The initial source review expired. Nothing was renewed.');
  const createdAt = new Date(at).toISOString();
  signal.throwIfAborted();
  try {
    await db
      .prepare(
        'INSERT INTO wallet_warmup_session_consents_v2(owner_id,id,review_id,terms_sha256,document,created_at) VALUES(?,?,?,?,?,?)',
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
    // No replacement write: recover the original outcome even after cancellation.
    const recoverySignal = AbortSignal.timeout(15000);
    const saved = await readWalletWarmupV2Consent(
      db,
      owner,
      input.id,
      recoverySignal,
    );
    if (saved && matches(saved)) return saved;
    await refuseLegacyApproval(db, owner, input, recoverySignal);
    await refuseExistingApproval(db, owner, input, recoverySignal);
    fail(
      'Versioned approval could not be confirmed. Recover the original ID before another save.',
    );
  }
  const saved = await readWalletWarmupV2Consent(
    db,
    owner,
    input.id,
    AbortSignal.timeout(15000),
  );
  if (!saved || !matches(saved))
    fail(
      'Versioned approval could not be confirmed. Recover the original ID.',
      503,
    );
  return saved;
}

async function refuseExistingApproval(
  db: D1Database,
  owner: string,
  input: z.infer<typeof request>,
  signal: AbortSignal,
) {
  const existing = await db
    .prepare(
      'SELECT id FROM wallet_warmup_session_consents_v2 WHERE owner_id=? AND review_id=? AND id<>?',
    )
    .bind(owner, input.reviewId, input.id)
    .first<{ id: string }>();
  signal.throwIfAborted();
  if (existing) {
    if (!uuid.safeParse(existing.id).success)
      fail('Saved versioned approval identity is inconsistent.', 503);
    const old = await readWalletWarmupV2Consent(db, owner, existing.id, signal);
    if (!old) fail('Saved versioned approval is inconsistent.', 503);
    throw new WalletWarmupV2ConsentError(
      'This review already has a versioned approval. Recover its original ID.',
      409,
      old.id,
    );
  }
}
