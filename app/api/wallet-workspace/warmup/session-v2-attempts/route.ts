import { z } from 'zod';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { env } from '@/lib/server-env';
import { walletRequest } from '@/lib/wallet-request';
import {
  warmupV2AttemptInput,
  warmupAttemptUuid,
} from '@/lib/wallet-warmup-session-v2-attempt-types';
import {
  prepareWalletWarmupV2Attempt,
  readWalletWarmupV2Attempt,
  publicWalletWarmupV2Attempt,
  WalletWarmupV2AttemptError,
  listWalletWarmupV2Attempts,
} from '@/lib/wallet-warmup-session-v2-attempts';
export const dynamic = 'force-dynamic';
const body = warmupV2AttemptInput
  .extend({ previewRequested: z.literal(true) })
  .strict();
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
function failure(error: unknown, signal: AbortSignal) {
  if (signal.aborted)
    return json(
      {
        error:
          'Request ended before confirmation. Recover the original unsigned request ID; no replacement is started automatically.',
      },
      408,
    );
  if (error instanceof z.ZodError)
    return json(
      { error: 'Choose the exact original unsigned request and saved head.' },
      400,
    );
  if (error instanceof WalletWarmupV2AttemptError)
    return json(
      {
        error: error.message,
        ...(error.recoveryId ? { recoveryId: error.recoveryId } : {}),
      },
      error.status,
    );
  return json(
    {
      error:
        'Unsigned attempt storage is unavailable. Keep the original request ID and recover before trying again.',
    },
    503,
  );
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json(
      { error: 'Sign in to recover an unsigned warmup preview.' },
      401,
    );
  const params = new URL(request.url).searchParams;
  const listing = params.has('journalId');
  const id = warmupAttemptUuid.safeParse(
    params.get(listing ? 'journalId' : 'id'),
  );
  const beforeText = params.get('before');
  const before =
    beforeText === null
      ? null
      : /^[1-9]\d{0,4}$/.test(beforeText)
        ? Number(beforeText)
        : NaN;
  if (
    !id.success ||
    params.getAll(listing ? 'journalId' : 'id').length !== 1 ||
    params.getAll('before').length > 1 ||
    (listing
      ? before !== null &&
        (!Number.isSafeInteger(before) || before < 1 || before > 14400)
      : params.has('before')) ||
    [...params.keys()].some(
      (k) => !(listing ? ['journalId', 'before'] : ['id']).includes(k),
    )
  )
    return json({ error: 'Choose one original unsigned request ID.' }, 400);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
  try {
    if (listing) {
      const page = await listWalletWarmupV2Attempts(
        getD1(),
        user.userId,
        id.data,
        before,
        signal,
      );
      signal.throwIfAborted();
      return json({ page });
    }
    const saved = await readWalletWarmupV2Attempt(
      getD1(),
      user.userId,
      id.data,
      signal,
    );
    signal.throwIfAborted();
    return saved
      ? json({ attempt: publicWalletWarmupV2Attempt(saved) })
      : json({ error: 'Unsigned request not found for this account.' }, 404);
  } catch (error) {
    return failure(error, signal);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json(
      { error: 'Sign in to request an unsigned warmup preview.' },
      401,
    );
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
                'Request the exact saved head separately. Wallet, amount and source selectors are not accepted.',
            },
            400,
          );
    }
    signal.throwIfAborted();
    const { previewRequested, ...selection } = input;
    const saved = await prepareWalletWarmupV2Attempt(
      getD1(),
      user.userId,
      selection,
      previewRequested,
      signal,
      env.JUPITER_API_KEY,
    );
    return json({ attempt: publicWalletWarmupV2Attempt(saved) });
  } catch (error) {
    return failure(error, signal);
  }
}
