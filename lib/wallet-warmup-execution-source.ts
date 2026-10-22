import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import {
  walletWarmupSessionDigest as digest,
  WARMUP_SESSION_REVIEW_FORMAT,
  WARMUP_SESSION_DOCUMENT_BYTES,
  WARMUP_SESSION_SOURCE_BYTES,
  WARMUP_SESSION_ROW_BYTES,
} from './wallet-warmup-session-digest';
import { readWalletWarmupSessionReview } from './wallet-warmup-session-storage';
import { WARMUP_RUNTIME_WALLET_BUSY_SQL } from './wallet-warmup-runtime-wallet-busy';
import { warmupExecutionTimestamp as iso } from './wallet-warmup-execution-manifest';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const selection = z.object({ reviewId: uuid, reviewSha256: hash }).strict();
const snapshotFormat = 'wallet-warmup-execution-source-snapshot-v1';
const rowSchema = z
  .object({
    owner_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    id: uuid,
    plan_id: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
    plan_revision: z.number().int().min(1).max(999999999),
    review_sha256: hash,
    source_sha256: hash,
    document: z.string().max(1048576),
    source: z.string().max(1048576),
    reviewed_at: iso,
    review_expires_at: iso,
    created_at: iso,
  })
  .strict();
const rowFields = [
  'owner_id',
  'id',
  'plan_id',
  'plan_revision',
  'review_sha256',
  'source_sha256',
  'document',
  'source',
  'reviewed_at',
  'review_expires_at',
  'created_at',
] as const;

// Exact projection used by loadWalletWarmupProgress. IS preserves NULL behavior;
// document bytes and signature columns both participate, not just receipt counts.
const buyFields = {
  id: 'b.id',
  planRevision: 'b.plan_revision',
  walletRevision: 'b.wallet_revision',
  cycle: 'b.cycle',
  wallet: 'b.wallet_address',
  document: 'b.document',
  mint: "json_extract(b.document,'$.mint')",
  acquiredRaw: "json_extract(b.document,'$.acquiredRaw')",
  remainingRaw:
    "COALESCE(b.remaining_raw,json_extract(b.document,'$.acquiredRaw'))",
  decimals: "json_extract(b.document,'$.decimals')",
  verified:
    "CASE WHEN json_extract(b.document,'$.signatureVerified')=1 AND json_extract(b.document,'$.wallet')=b.wallet_address AND json_extract(b.document,'$.signature')=b.signature THEN 1 ELSE 0 END",
  commitment: "json_extract(b.document,'$.commitment')",
  network: "json_extract(b.document,'$.network')",
};
const sellFields = {
  id: 's.id',
  document: 's.document',
  buyId: 's.buy_receipt_id',
  consumedRaw: 's.consumed_raw',
  verified:
    "CASE WHEN json_extract(s.document,'$.signatureVerified')=1 AND json_extract(s.document,'$.signature')=s.signature AND json_extract(s.document,'$.consumedRaw')=s.consumed_raw AND json_extract(s.document,'$.buyReceiptId')=s.buy_receipt_id THEN 1 ELSE 0 END",
  commitment: "json_extract(s.document,'$.commitment')",
  network: "json_extract(s.document,'$.network')",
};
const matches = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(
      ([key, expression]) =>
        `(${expression}) IS json_extract(j.value,'$.${key}')`,
    )
    .join(' AND ');

/** Fixed alias r is a verified retained-review row. Future publication must use
 * this same predicate inside its transaction, not trust a previous SELECT. */
export const WARMUP_EXECUTION_SOURCE_CURRENT_SQL = `
 strftime('%Y-%m-%dT%H:%M:%fZ','now')>=r.reviewed_at
 AND strftime('%Y-%m-%dT%H:%M:%fZ','now')>=r.created_at
 AND strftime('%Y-%m-%dT%H:%M:%fZ','now')<r.review_expires_at
 AND EXISTS(SELECT 1 FROM wallet_warmup_plans p WHERE p.owner_id=r.owner_id AND p.id=r.plan_id
  AND p.revision=r.plan_revision AND p.archived=0 AND json_extract(p.document,'$.chain')='Solana'
  AND p.document=json_extract(r.source,'$.planDocument') AND p.updated_at=json_extract(r.source,'$.planUpdatedAt'))
 AND NOT EXISTS(SELECT 1 FROM json_each(r.document,'$.wallets') selected
  WHERE NOT EXISTS(SELECT 1 FROM workspace_wallets w WHERE w.owner_id=r.owner_id AND w.chain='Solana'
   AND w.address=json_extract(selected.value,'$.wallet') AND w.revision=json_extract(selected.value,'$.walletRevision') AND w.archived=0)
  OR EXISTS(SELECT 1 FROM solana_swap_reservations x WHERE x.owner_id=r.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet'))
  OR EXISTS(SELECT 1 FROM solana_execution_reservations x WHERE x.owner_id=r.owner_id AND x.wallet_address=json_extract(selected.value,'$.wallet')))
 AND NOT EXISTS(SELECT 1 FROM (SELECT r.owner_id AS owner_id,r.document AS review_document) c
  WHERE (${WARMUP_RUNTIME_WALLET_BUSY_SQL}) IS NOT 0)
 AND (SELECT count(*) FROM warmup_buy_receipts b WHERE b.owner_id=r.owner_id AND b.plan_id=r.plan_id)=json_array_length(r.source,'$.buys')
 AND NOT EXISTS(SELECT 1 FROM json_each(r.source,'$.buys') j WHERE NOT EXISTS(
  SELECT 1 FROM warmup_buy_receipts b WHERE b.owner_id=r.owner_id AND b.plan_id=r.plan_id AND ${matches(buyFields)}))
 AND (SELECT count(*) FROM warmup_sell_receipts s WHERE s.owner_id=r.owner_id AND s.plan_id=r.plan_id)=json_array_length(r.source,'$.sells')
 AND NOT EXISTS(SELECT 1 FROM json_each(r.source,'$.sells') j WHERE NOT EXISTS(
  SELECT 1 FROM warmup_sell_receipts s WHERE s.owner_id=r.owner_id AND s.plan_id=r.plan_id AND ${matches(sellFields)}))`;

export class WarmupExecutionSourceError extends Error {
  constructor() {
    super(
      'Execution source is unavailable or changed. Request a fresh review.',
    );
  }
}
const fail = (): never => {
  throw new WarmupExecutionSourceError();
};

async function readExecutionReviewRow(
  db: D1Database,
  owner: string,
  input: { reviewId: string },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const row = await db
    .prepare(`SELECT owner_id,id,plan_id,plan_revision,review_sha256,source_sha256,
       document,source,reviewed_at,review_expires_at,created_at FROM wallet_warmup_session_reviews WHERE owner_id=? AND id=?`)
    .bind(owner, input.reviewId)
    .first();
  signal.throwIfAborted();
  const parsed = rowSchema.parse(row);
  const documentBytes = new TextEncoder().encode(parsed.document).byteLength;
  const sourceBytes = new TextEncoder().encode(parsed.source).byteLength;
  if (
    documentBytes > WARMUP_SESSION_DOCUMENT_BYTES ||
    sourceBytes > WARMUP_SESSION_SOURCE_BYTES ||
    documentBytes + sourceBytes > WARMUP_SESSION_ROW_BYTES
  )
    fail();
  return parsed;
}

async function verifyRetainedMaterial(
  before: z.infer<typeof rowSchema>,
  retained: Awaited<ReturnType<typeof readWalletWarmupSessionReview>>,
) {
  if (!retained) return fail();
  if (
    retained.id !== before.id ||
    retained.planId !== before.plan_id ||
    retained.planRevision !== before.plan_revision ||
    retained.reviewSha256 !== before.review_sha256 ||
    retained.reviewedAt !== before.reviewed_at ||
    retained.reviewExpiresAt !== before.review_expires_at ||
    retained.createdAt !== before.created_at ||
    !retained.document.actions.length
  )
    fail();
  if (
    (await digest(before.source)) !== before.source_sha256 ||
    before.document !==
      canonical({
        format: WARMUP_SESSION_REVIEW_FORMAT,
        contextSha256: before.review_sha256,
        sourceSha256: before.source_sha256,
        ...retained.document,
      })
  )
    fail();
  const documentSha256 = await digest(before.document);
  const snapshotSha256 = await digest(
    canonical({ format: snapshotFormat, record: before }),
  );

  return { retained, documentSha256, snapshotSha256 };
}

/** Server-internal currentness snapshot only. Owner must come from a verified
 * session. Retained receipt replay is not a fresh chain proof, asset/rent
 * evidence, a budget allocation, reservation or execution authorization. */
export async function readWarmupExecutionSource(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
  clock: () => number = Date.now,
) {
  try {
    if (typeof owner !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(owner))
      fail();
    const input = selection.parse(value);
    const read = () => readExecutionReviewRow(db, owner, input, signal);
    const before = await read();
    const fresh = () => {
      signal.throwIfAborted();
      const now = clock();
      if (
        !Number.isSafeInteger(now) ||
        now < Date.parse(before.reviewed_at) ||
        now < Date.parse(before.created_at) ||
        now >= Date.parse(before.review_expires_at)
      )
        fail();
      return new Date(now).toISOString();
    };
    fresh();
    if (
      before.owner_id !== owner ||
      before.id !== input.reviewId ||
      before.review_sha256 !== input.reviewSha256
    )
      fail();
    const retained = await readWalletWarmupSessionReview(
      db,
      owner,
      input.reviewId,
    );
    fresh();
    const material = await verifyRetainedMaterial(before, retained);
    fresh();
    const current = await db
      .prepare(`SELECT (${WARMUP_EXECUTION_SOURCE_CURRENT_SQL}) AS current
     FROM wallet_warmup_session_reviews r WHERE ${rowFields.map((key) => `r.${key} IS ?`).join(' AND ')}`)
      .bind(...rowFields.map((key) => before[key]))
      .first<{ current: number }>();
    fresh();
    if (current?.current !== 1 || canonical(await read()) !== canonical(before))
      fail();
    const checkedAt = fresh();
    return {
      format: snapshotFormat,
      ownerId: owner,
      retainedReview: material.retained,
      reviewDocument: before.document,
      reviewDocumentSha256: material.documentSha256,
      sourceDocument: before.source,
      sourceSha256: before.source_sha256,
      sourceSnapshotSha256: material.snapshotSha256,
      checkedAt,
      scope: 'retained-source-currentness-only' as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
      automaticExecutionAllowed: false as const,
    };
  } catch {
    signal.throwIfAborted();
    return fail();
  }
}

export class WarmupRetainedSourceError extends Error {
  constructor() {
    super('Retained original warmup review is unavailable or changed.');
    this.name = 'WarmupRetainedSourceError';
  }
}
/** Historical original-source integrity only. Owner must be authenticated by
 * the caller. Current plan/wallet/lot/reservation state and the wall clock are
 * deliberately not consulted: a metadata recovery read never renews authority. */
export async function readRetainedWarmupExecutionSource(
  db: D1Database,
  owner: string,
  value: unknown,
  signal: AbortSignal,
) {
  try {
    if (typeof owner !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(owner))
      return fail();
    const input = selection.parse(value);
    const before = await readExecutionReviewRow(db, owner, input, signal);
    if (
      before.owner_id !== owner ||
      before.id !== input.reviewId ||
      before.review_sha256 !== input.reviewSha256 ||
      Date.parse(before.created_at) < Date.parse(before.reviewed_at) ||
      Date.parse(before.created_at) >= Date.parse(before.review_expires_at)
    )
      return fail();
    const kept = await readWalletWarmupSessionReview(db, owner, input.reviewId);
    signal.throwIfAborted();
    const material = await verifyRetainedMaterial(before, kept);
    signal.throwIfAborted();
    if (
      canonical(await readExecutionReviewRow(db, owner, input, signal)) !==
      canonical(before)
    )
      return fail();
    signal.throwIfAborted();
    return {
      format: snapshotFormat,
      ownerId: owner,
      retainedReview: material.retained,
      reviewDocument: before.document,
      reviewDocumentSha256: material.documentSha256,
      sourceDocument: before.source,
      sourceSha256: before.source_sha256,
      sourceSnapshotSha256: material.snapshotSha256,
      scope: 'retained-original-source-integrity-only' as const,
      currentSourceVerified: false as const,
      signingAllowed: false as const,
      executionAllowed: false as const,
      automaticExecutionAllowed: false as const,
    };
  } catch {
    signal.throwIfAborted();
    throw new WarmupRetainedSourceError();
  }
}
