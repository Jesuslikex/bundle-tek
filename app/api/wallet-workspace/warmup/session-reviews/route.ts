import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { UUID } from '@/lib/wallet-operation';
import {
  readWalletWarmupSessionReview,
  retainWalletWarmupSessionReview,
  WalletWarmupSessionStorageError,
  type WarmupSessionReviewSelection,
} from '@/lib/wallet-warmup-session-storage';
import { WalletWarmupProgressError } from '@/lib/wallet-warmup-progress-server';
import { WalletWarmupSessionReviewError } from '@/lib/wallet-warmup-session-review';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const cancelled = () =>
  json(
    {
      error:
        'Request cancelled. Recover the same review ID before saving again.',
    },
    408,
  );
function failure(error: unknown, request: Request) {
  if (request.signal.aborted) return cancelled();
  if (
    error instanceof WalletWarmupSessionStorageError ||
    error instanceof WalletWarmupProgressError
  )
    return json({ error: error.message }, error.status);
  if (error instanceof WalletWarmupSessionReviewError)
    return json({ error: error.message }, 409);
  return json(
    {
      error:
        'Retained review unavailable. Recover the same review ID before saving again.',
    },
    503,
  );
}

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to recover a warmup review.' }, 401);
  const params = new URL(request.url).searchParams,
    id = params.get('id');
  if (
    [...params.keys()].length !== 1 ||
    !id ||
    !UUID.test(id) ||
    id !== id.toLowerCase()
  )
    return json({ error: 'Choose one retained review ID.' }, 400);
  if (request.signal.aborted) return cancelled();
  try {
    const retainedReview = await readWalletWarmupSessionReview(
      getD1(),
      user.userId,
      id,
    );
    if (request.signal.aborted) return cancelled();
    return retainedReview
      ? json({ retainedReview })
      : json({ error: 'Retained review not found for this account.' }, 404);
  } catch (error) {
    return failure(error, request);
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to save a warmup review.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin request required.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  let input: Record<string, unknown>;
  try {
    input = await walletRequest(request, 2048);
    const keys = [
      'id',
      'planId',
      'revision',
      'reviewedAt',
      'reviewSha256',
      'save',
    ];
    if (
      Object.keys(input).length !== keys.length ||
      Object.keys(input).some((k) => !keys.includes(k)) ||
      input.save !== true ||
      typeof input.id !== 'string' ||
      typeof input.planId !== 'string' ||
      typeof input.revision !== 'number' ||
      typeof input.reviewedAt !== 'string' ||
      typeof input.reviewSha256 !== 'string'
    )
      throw Error('Invalid selection');
  } catch (error) {
    const tooLarge =
      error instanceof Error && error.message === 'Wallet request too large.';
    return json(
      {
        error: tooLarge
          ? 'Request too large.'
          : 'Choose the exact reviewed session and request saving explicitly.',
      },
      tooLarge ? 413 : 400,
    );
  }
  if (request.signal.aborted) return cancelled();
  try {
    const { save: _save, ...selection } = input;
    const retainedReview = await retainWalletWarmupSessionReview(
      getD1(),
      user.userId,
      selection as WarmupSessionReviewSelection,
      true,
      request.signal,
    );
    if (request.signal.aborted) return cancelled();
    return json({ retainedReview });
  } catch (error) {
    return failure(error, request);
  }
}
