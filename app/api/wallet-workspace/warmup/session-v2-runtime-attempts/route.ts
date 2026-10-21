import { z } from 'zod';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { env } from '@/lib/server-env';
import { walletRequest } from '@/lib/wallet-request';
import {
  warmupV2AttemptInput,
  warmupAttemptUuid,
  WalletWarmupV2AttemptError,
} from '@/lib/wallet-warmup-session-v2-attempt-types';
import {
  prepareWalletWarmupV2RuntimeAttempt,
  readWalletWarmupV2RuntimeAttempt,
  publicWalletWarmupV2RuntimeAttempt,
} from '@/lib/wallet-warmup-session-v2-attempts';
export const dynamic = 'force-dynamic';
const body = warmupV2AttemptInput
  .extend({ runtimeRequested: z.literal(true) })
  .strict();
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
function failure(error: unknown, signal: AbortSignal) {
  if (signal.aborted)
    return json(
      {
        error:
          'Request ended before confirmation. Keep the original runtime request ID and recover it; no replacement is started automatically.',
      },
      408,
    );
  if (error instanceof WalletWarmupV2AttemptError)
    return json(
      {
        error: error.message,
        ...(error.recoveryId ? { recoveryId: error.recoveryId } : {}),
      },
      error.status,
    );
  if (error instanceof z.ZodError)
    return json(
      { error: 'Choose the exact original saved request and head.' },
      400,
    );
  return json(
    {
      error:
        'Runtime observation storage is unavailable. Recover the same request ID before trying again.',
    },
    503,
  );
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to recover runtime observations.' }, 401);
  const params = new URL(request.url).searchParams,
    id = warmupAttemptUuid.safeParse(params.get('id'));
  if (
    !id.success ||
    params.getAll('id').length !== 1 ||
    [...params.keys()].some((k) => k !== 'id')
  )
    return json({ error: 'Choose one original runtime request ID.' }, 400);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
  try {
    const saved = await readWalletWarmupV2RuntimeAttempt(
      getD1(),
      user.userId,
      id.data,
      signal,
    );
    signal.throwIfAborted();
    return saved
      ? json(publicWalletWarmupV2RuntimeAttempt(saved))
      : json({ error: 'Runtime request not found for this account.' }, 404);
  } catch (error) {
    return failure(error, signal);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to request runtime observations.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin request required.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(35000)]);
  try {
    let input: z.infer<typeof body>;
    try {
      input = body.parse(await walletRequest(request, 2048, signal));
    } catch (error) {
      if (signal.aborted) return failure(error, signal);
      return error instanceof Error &&
        error.message === 'Wallet request too large.'
        ? json({ error: 'Request too large.' }, 413)
        : json(
            {
              error:
                'Approve this exact runtime read separately. Wallet, amount, source and provider selectors are not accepted.',
            },
            400,
          );
    }
    const { runtimeRequested, ...selection } = input;
    const saved = await prepareWalletWarmupV2RuntimeAttempt(
      getD1(),
      user.userId,
      selection,
      runtimeRequested,
      signal,
      env.JUPITER_API_KEY,
    );
    const retained = await readWalletWarmupV2RuntimeAttempt(
      getD1(),
      user.userId,
      saved.lease.id,
      signal,
    );
    signal.throwIfAborted();
    if (!retained)
      return json(
        { error: 'Keep the original request ID and recover its saved result.' },
        503,
      );
    return json(publicWalletWarmupV2RuntimeAttempt(retained));
  } catch (error) {
    return failure(error, signal);
  }
}
