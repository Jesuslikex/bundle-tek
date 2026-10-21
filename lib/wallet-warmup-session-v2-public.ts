import { z } from 'zod';
import {
  WalletWarmupV2ConsentError,
  type reviewWalletWarmupV2Consent,
  type readWalletWarmupV2Consent,
} from './wallet-warmup-session-v2-consent';
/** Private services keep their existing shape. HTTP adds only the exact parent's
 * creation time needed by the browser's retained-source validator. */
export async function publicWalletWarmupV2Consent(
  db: D1Database,
  owner: string,
  value:
    | Awaited<ReturnType<typeof reviewWalletWarmupV2Consent>>
    | NonNullable<Awaited<ReturnType<typeof readWalletWarmupV2Consent>>>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const parent = await db
    .prepare(
      'SELECT created_at AS createdAt FROM wallet_warmup_session_reviews WHERE owner_id=? AND id=? AND review_sha256=? AND document=?',
    )
    .bind(
      owner,
      value.terms.reviewId,
      value.terms.reviewSha256,
      value.terms.reviewDocument,
    )
    .first<{ createdAt: string }>();
  signal.throwIfAborted();
  const date = z.iso
    .datetime()
    .refine((v) => new Date(v).toISOString() === v)
    .safeParse(parent?.createdAt);
  if (!date.success)
    throw new WalletWarmupV2ConsentError(
      'The retained source review changed. Recover its original ID.',
      503,
    );
  const common = {
    terms: value.terms,
    termsSha256: value.termsSha256,
    reviewCreatedAt: date.data,
  };
  return 'id' in value
    ? { ...common, id: value.id, createdAt: value.createdAt }
    : {
        ...common,
        reviewedAt: value.reviewedAt,
        reviewExpiresAt: value.reviewExpiresAt,
      };
}
