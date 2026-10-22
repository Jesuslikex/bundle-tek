import { z } from 'zod';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import {
  parseWarmupExecutionIntent,
  bindWarmupExecutionManifest,
  warmupExecutionHash as hash,
  warmupExecutionId as uuid,
  warmupExecutionTimestamp as iso,
} from './wallet-warmup-execution-manifest';
import { reviewWalletWarmupExecutionPacing } from './wallet-warmup-execution-pacing';

// An upper bound for this terms domain, not a replacement for the exact
// retained source expiry which future storage admission must compare.
export const WARMUP_EXECUTION_REVIEW_MAX_MS = 60000;
const termsSchema = z
  .object({
    format: z.literal('wallet-warmup-execution-terms-v1'),
    intent: z.unknown().transform(parseWarmupExecutionIntent),
    review: z
      .object({
        id: uuid,
        sha256: hash,
        reviewedAt: iso,
        reviewExpiresAt: iso,
      })
      .strict(),
    verifierEvidenceSha256: hash,
  })
  .strict();
export const WARMUP_EXECUTION_ACKNOWLEDGEMENT =
  'I approve these exact wallets, actions, gross spending limits and expiry.';
const approvalSchema = z
  .object({
    format: z.literal('wallet-warmup-execution-approval-v1'),
    id: uuid,
    rootId: uuid,
    ownerId: z.string().min(1).max(256),
    reviewId: uuid,
    termsSha256: hash,
    approvedAt: iso,
    sessionExpiresAt: iso,
    acknowledgement: z.literal(WARMUP_EXECUTION_ACKNOWLEDGEMENT),
  })
  .strict();
const rootSchema = z
  .object({
    format: z.literal('wallet-warmup-execution-root-v1'),
    terms: termsSchema,
    termsSha256: hash,
    consentSha256: hash,
  })
  .strict();
const expectedSchema = z
  .object({
    id: uuid,
    ownerId: z.string().min(1).max(256),
    consentId: uuid,
    reviewId: uuid,
    rootSha256: hash,
  })
  .strict();
export type WarmupExecutionTerms = z.infer<typeof termsSchema>;
export type WarmupExecutionApproval = z.infer<typeof approvalSchema>;
export type WarmupExecutionRoot = z.infer<typeof rootSchema>;
function fail(): never {
  throw Error('Execution terms, approval or expected root identity differ.');
}
function checkTerms(terms: WarmupExecutionTerms) {
  const reviewMs =
    Date.parse(terms.review.reviewExpiresAt) -
    Date.parse(terms.review.reviewedAt);
  if (
    terms.review.reviewedAt !== terms.intent.createdAt ||
    reviewMs <= 0 ||
    reviewMs > WARMUP_EXECUTION_REVIEW_MAX_MS ||
    new Set([terms.intent.id, terms.intent.consentId, terms.review.id]).size !==
      3
  )
    fail();
  return terms;
}

/** Model binding only. Digests do not verify sources, evidence, ownership or a
 * human approval. Future admission must independently rebuild all terms from
 * owned sources and real verifier facts, and recheck current freshness in SQL. */
export async function bindWarmupExecutionTerms(value: unknown) {
  const terms = checkTerms(termsSchema.parse(value));
  return { terms, termsSha256: await digest(canonical(terms)) };
}

/** Historical deterministic binding, not admission. There is deliberately no
 * clock refresh, legacy-consent upgrade, persistence, signer or API caller. */
export async function bindWarmupExecutionRoot(
  rawTerms: unknown,
  rawApproval: unknown,
) {
  // Snapshot both mutable inputs before the first asynchronous digest.
  const terms = checkTerms(termsSchema.parse(rawTerms));
  const approval = approvalSchema.parse(rawApproval);
  const intent = terms.intent;
  const approvedAt = Date.parse(approval.approvedAt);
  if (
    approval.id !== intent.consentId ||
    approval.rootId !== intent.id ||
    approval.ownerId !== intent.ownerId ||
    approval.reviewId !== terms.review.id ||
    approval.sessionExpiresAt !== intent.expiresAt ||
    approvedAt < Date.parse(terms.review.reviewedAt) ||
    approvedAt >= Date.parse(terms.review.reviewExpiresAt) ||
    approvedAt >= Date.parse(intent.expiresAt)
  )
    fail();
  if (
    !reviewWalletWarmupExecutionPacing(
      {
        actions: intent.actions.map((action) => ({
          id: action.id,
          scheduledAt: action.scheduledAt,
        })),
        sessionExpiresAt: intent.expiresAt,
      },
      approvedAt,
    ).fitsMinimumPacing
  )
    fail();
  const termsSha256 = await digest(canonical(terms));
  if (approval.termsSha256 !== termsSha256) fail();
  const consentSha256 = await digest(canonical(approval));
  const root: WarmupExecutionRoot = {
    format: 'wallet-warmup-execution-root-v1',
    terms,
    termsSha256,
    consentSha256,
  };
  const manifest = await bindWarmupExecutionManifest({
    ...intent,
    format: 'wallet-warmup-execution-manifest-v1',
    consentSha256,
  });
  return {
    root,
    rootSha256: await digest(canonical(root)),
    approval,
    manifest: manifest.manifest,
    manifestSha256: manifest.sha256,
    scope: 'execution-bookkeeping-model-only' as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    automaticExecutionAllowed: false as const,
  };
}

/** The expected selector must come from separately admitted owned storage,
 * never from the untrusted root. Exact historical recovery grants no authority. */
export async function readWarmupExecutionRootBinding(
  rawRoot: unknown,
  rawApproval: unknown,
  rawExpected: z.infer<typeof expectedSchema>,
) {
  const root = rootSchema.parse(rawRoot);
  const approval = approvalSchema.parse(rawApproval);
  const expected = expectedSchema.parse(rawExpected);
  const { intent } = root.terms;
  if (
    intent.id !== expected.id ||
    intent.ownerId !== expected.ownerId ||
    intent.consentId !== expected.consentId ||
    root.terms.review.id !== expected.reviewId
  )
    fail();
  const bound = await bindWarmupExecutionRoot(root.terms, approval);
  if (
    bound.rootSha256 !== expected.rootSha256 ||
    canonical(bound.root) !== canonical(root)
  )
    fail();
  return bound;
}
