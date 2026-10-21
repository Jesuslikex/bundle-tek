import { warmupSessionReviewFixture } from './warmup-session-review-fixture';
import { walletWarmupSessionView } from '../lib/wallet-warmup-session-view';
import { walletWarmupSessionRetainedView } from '../lib/wallet-warmup-session-retained-view';
import { walletWarmupSessionDigest as digest } from '../lib/wallet-warmup-session-digest';
const canonical = (v: unknown) =>
  JSON.stringify(v, (_k, node: unknown) =>
    node && typeof node === 'object' && !Array.isArray(node)
      ? Object.fromEntries(
          Object.entries(node).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : node,
  );
/** Synthetic public DTOs for rendering only. No real account, SQL, provider, key or transaction. */
export async function warmupConsentClientFixture(at = Date.now()) {
  const f = warmupSessionReviewFixture(at),
    view = walletWarmupSessionView(f.response(at), f.plan, at);
  const { contextKey, ...document } = view.review,
    reviewSha256 = await digest(contextKey),
    reviewId = '00000000-0000-4000-8000-000000000001',
    createdAt = new Date(at).toISOString();
  const retained = await walletWarmupSessionRetainedView(
    {
      retainedReview: {
        id: reviewId,
        planId: f.plan.id,
        planRevision: f.plan.revision,
        reviewSha256,
        reviewedAt: view.review.reviewedAt,
        reviewExpiresAt: view.reviewExpiresAt,
        createdAt,
        document,
      },
    },
    { id: reviewId, planId: f.plan.id },
    view.review,
  );
  const reviewDocument = canonical({
    format: 'wallet-warmup-session-review-v1',
    contextSha256: reviewSha256,
    sourceSha256: 'b'.repeat(64),
    ...document,
  });
  async function preview(deadline: string) {
    const terms = {
      format: 'wallet-warmup-session-consent-v1' as const,
      reviewId,
      reviewSha256,
      sessionExpiresAt: deadline,
      reviewDocument,
      executionAllowed: false as const,
      signingAllowed: false as const,
      automaticExecutionAllowed: false as const,
    };
    return {
      consentReview: {
        terms,
        termsSha256: await digest(canonical(terms)),
        reviewCreatedAt: createdAt,
        reviewedAt: view.review.reviewedAt,
        reviewExpiresAt: view.reviewExpiresAt,
      },
    };
  }
  function saved(id: string, body: Awaited<ReturnType<typeof preview>>) {
    return {
      consent: {
        id,
        createdAt,
        terms: body.consentReview.terms,
        termsSha256: body.consentReview.termsSha256,
        reviewCreatedAt: createdAt,
      },
    };
  }
  return { plan: f.plan, view, retained, preview, saved };
}
