import type { SavedWarmup } from './wallet-warmup-storage';
import type { WarmupCycleProgress } from './warmup-cycle-progress';
import type { WarmupLotPerformance } from './warmup-lot-performance';
import {
  reviewWalletWarmupSession,
  type WalletWarmupSessionReview,
} from './wallet-warmup-session-review';

const fail = (): never => {
  throw new Error(
    'Session review is unavailable or changed. Request a fresh review.',
  );
};
function canonical(value: unknown) {
  return JSON.stringify(value, (_key, node: unknown) =>
    node && typeof node === 'object' && !Array.isArray(node)
      ? Object.fromEntries(
          Object.entries(node).sort(([a], [b]) => a.localeCompare(b)),
        )
      : node,
  );
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail();
  return value as Record<string, unknown>;
}
export type WalletWarmupSessionView = {
  review: WalletWarmupSessionReview;
  reviewExpiresAt: string;
  deadline: number;
};

/** Rebuild every displayed field from the exact public server context. This never grants authority. */
export function walletWarmupSessionView(
  value: unknown,
  plan: SavedWarmup,
  now = Date.now(),
): WalletWarmupSessionView {
  try {
    const body = record(value),
      review = record(body.review);
    if (
      Object.keys(body).length !== 2 ||
      typeof body.reviewExpiresAt !== 'string' ||
      typeof review.reviewedAt !== 'string' ||
      typeof review.contextKey !== 'string' ||
      review.contextKey.length > 16 * 1024 * 1024
    )
      return fail();
    const at = Date.parse(review.reviewedAt),
      expires = Date.parse(body.reviewExpiresAt);
    if (
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(at) ||
      !Number.isSafeInteger(expires) ||
      new Date(at).toISOString() !== review.reviewedAt ||
      new Date(expires).toISOString() !== body.reviewExpiresAt ||
      expires - at !== 60000 ||
      expires <= now
    )
      return fail();
    const context: unknown = JSON.parse(review.contextKey);
    if (
      !Array.isArray(context) ||
      context.length !== 4 ||
      canonical(context[0]) !== canonical(plan)
    )
      return fail();
    const rebuilt = reviewWalletWarmupSession(
      context[0] as SavedWarmup,
      context[1] as WarmupCycleProgress,
      context[2] as WarmupLotPerformance,
      at,
    );
    if (
      canonical(rebuilt) !== canonical(review) ||
      rebuilt.contextKey !== review.contextKey
    )
      return fail();
    return {
      review: rebuilt,
      reviewExpiresAt: body.reviewExpiresAt,
      deadline: Math.min(expires, now + 60000),
    };
  } catch {
    return fail();
  }
}
