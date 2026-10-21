import { z } from 'zod';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { UUID } from '@/lib/wallet-operation';
import {
  reviewWalletWarmupSessionConsent,
  retainWalletWarmupSessionConsent,
  readWalletWarmupSessionConsent,
  WalletWarmupSessionConsentError,
} from '@/lib/wallet-warmup-session-consent';
import { WalletWarmupSessionStorageError } from '@/lib/wallet-warmup-session-storage';
import { WalletWarmupSessionReviewError } from '@/lib/wallet-warmup-session-review';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const fields = {
  reviewId: z.string(),
  reviewSha256: z.string(),
  sessionExpiresAt: z.string(),
};
const body = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('review'), ...fields }).strict(),
  z
    .object({
      operation: z.literal('save'),
      ...fields,
      id: z.string(),
      termsSha256: z.string(),
      approved: z.literal(true),
    })
    .strict(),
]);
const cancelled = () =>
  json(
    {
      error:
        'Request cancelled. Recover the same consent ID before saving again.',
    },
    408,
  );
async function publicRecord<
  T extends {
    terms: { reviewId: string; reviewSha256: string; reviewDocument: string };
  },
>(db: D1Database, owner: string, value: T, signal: AbortSignal) {
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
  if (!parent)
    throw new WalletWarmupSessionConsentError(
      'The retained source review changed. Recover this approval before another save.',
      503,
    );
  return { ...value, reviewCreatedAt: parent.createdAt };
}
function failure(error: unknown, request: Request) {
  if (request.signal.aborted) return cancelled();
  if (error instanceof z.ZodError)
    return json(
      { error: 'Choose the exact session terms and approve them separately.' },
      400,
    );
  if (
    error instanceof WalletWarmupSessionConsentError ||
    error instanceof WalletWarmupSessionStorageError
  )
    return json(
      {
        error: error.message,
        ...(error instanceof WalletWarmupSessionConsentError && error.recoveryId
          ? { recoveryId: error.recoveryId }
          : {}),
      },
      error.status,
    );
  if (error instanceof WalletWarmupSessionReviewError)
    return json(
      { error: 'The source review is unavailable. Request a fresh review.' },
      409,
    );
  return json(
    {
      error:
        'Session approval unavailable. Keep its ID and recover before another save.',
    },
    503,
  );
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to recover a session approval.' }, 401);
  const params = new URL(request.url).searchParams,
    id = params.get('id');
  if (
    [...params.keys()].length !== 1 ||
    !id ||
    !UUID.test(id) ||
    id !== id.toLowerCase()
  )
    return json({ error: 'Choose one session consent ID.' }, 400);
  if (request.signal.aborted) return cancelled();
  try {
    const db = getD1();
    const consent = await readWalletWarmupSessionConsent(
      db,
      user.userId,
      id,
      request.signal,
    );
    if (request.signal.aborted) return cancelled();
    const projected = consent
      ? await publicRecord(db, user.userId, consent, request.signal)
      : null;
    return projected
      ? json({ consent: projected })
      : json({ error: 'Session approval not found for this account.' }, 404);
  } catch (error) {
    return failure(error, request);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to review a session approval.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin request required.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  if (request.signal.aborted) return cancelled();
  let input: z.infer<typeof body>;
  try {
    input = body.parse(await walletRequest(request, 2048));
  } catch (error) {
    if (request.signal.aborted) return cancelled();
    const large =
      error instanceof Error && error.message === 'Wallet request too large.';
    return json(
      {
        error: large
          ? 'Request too large.'
          : 'Choose the exact session terms and approve them separately.',
      },
      large ? 413 : 400,
    );
  }
  if (request.signal.aborted) return cancelled();
  try {
    const db = getD1();
    if (input.operation === 'review') {
      const { operation: _operation, ...selection } = input;
      const consentReview = await reviewWalletWarmupSessionConsent(
        db,
        user.userId,
        selection,
        request.signal,
      );
      if (request.signal.aborted) return cancelled();
      return json({
        consentReview: await publicRecord(
          db,
          user.userId,
          consentReview,
          request.signal,
        ),
      });
    }
    const { operation: _operation, approved, ...selection } = input;
    const consent = await retainWalletWarmupSessionConsent(
      db,
      user.userId,
      selection,
      approved,
      request.signal,
    );
    if (request.signal.aborted) return cancelled();
    return json({
      consent: await publicRecord(db, user.userId, consent, request.signal),
    });
  } catch (error) {
    return failure(error, request);
  }
}
