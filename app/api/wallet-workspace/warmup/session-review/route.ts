import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import {
  loadWalletWarmupProgress,
  WalletWarmupProgressError,
} from '@/lib/wallet-warmup-progress-server';
import {
  reviewWalletWarmupSession,
  WalletWarmupSessionReviewError,
} from '@/lib/wallet-warmup-session-review';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to review a warmup session.' }, 401);
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
    if (
      Object.keys(input).some((key) => key !== 'id' && key !== 'revision') ||
      typeof input.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(input.id) ||
      typeof input.revision !== 'number' ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      input.revision >= 1000000000
    )
      throw new Error('Invalid review input.');
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error &&
          error.message === 'Wallet request too large.'
            ? 'Request too large.'
            : 'Choose a saved plan and its current revision.',
      },
      error instanceof Error && error.message === 'Wallet request too large.'
        ? 413
        : 400,
    );
  }
  if (request.signal.aborted)
    return json({ error: 'Session review cancelled.' }, 408);
  try {
    const { plan, progress, performance } = await loadWalletWarmupProgress(
      getD1(),
      user.userId,
      input.id as string,
      input.revision as number,
      false,
      true,
    );
    if (request.signal.aborted)
      return json({ error: 'Session review cancelled.' }, 408);
    const now = Date.now(),
      review = reviewWalletWarmupSession(plan, progress, performance, now);
    return json({
      review,
      reviewExpiresAt: new Date(now + 60000).toISOString(),
    });
  } catch (error) {
    if (error instanceof WalletWarmupProgressError)
      return json({ error: error.message }, error.status);
    if (error instanceof WalletWarmupSessionReviewError)
      return json({ error: error.message }, 409);
    return json(
      { error: 'Warmup session review unavailable. No session was started.' },
      503,
    );
  }
}
