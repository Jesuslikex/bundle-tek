import { z } from 'zod';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { env } from '@/lib/server-env';
import { walletRequest } from '@/lib/wallet-request';
import {
  readWalletWarmupSessionPreparation,
  prepareWalletWarmupSessionAction,
  WalletWarmupSessionPreparationError,
} from '@/lib/wallet-warmup-session-preparation';
import {
  createWalletWarmupSessionProvider,
  WalletWarmupSessionProviderError,
  WARMUP_SESSION_PREPARATION_TIMEOUT_MS,
} from '@/lib/wallet-warmup-session-provider';
import { publicWalletWarmupSessionPreparation as project } from '@/lib/wallet-warmup-session-preparation-public';
import { WalletWarmupJournalError } from '@/lib/wallet-warmup-session-journal-storage';
import { WalletRpcError } from '@/lib/wallet-balances';
import { WarmupQuoteError } from '@/lib/warmup-swap-quote';
export const dynamic = 'force-dynamic';
const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const body = z
  .object({
    id: uuid,
    journalId: uuid,
    version: z.number().int().min(1).max(4095),
    headSha256: z.string().regex(/^[a-f0-9]{64}$/),
    prepareRequested: z.literal(true),
  })
  .strict();
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(status === 429 ? { 'retry-after': '30' } : {}),
    },
  });
const cancelled = () =>
  json(
    {
      error:
        'Preparation request ended before its result was confirmed. Recover the same ID before another attempt.',
    },
    408,
  );
function failure(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return cancelled();
  if (error instanceof z.ZodError)
    return json(
      { error: 'Choose the exact saved session preparation request.' },
      400,
    );
  if (error instanceof WalletWarmupSessionPreparationError)
    return json(
      {
        error: error.message,
        ...(error.recoveryId ? { recoveryId: error.recoveryId } : {}),
      },
      error.status,
    );
  if (error instanceof WalletWarmupSessionProviderError)
    return json({ error: error.message }, error.status);
  if (error instanceof WalletWarmupJournalError)
    return json(
      {
        error:
          'Saved session differs. Recover its original status before preparing.',
      },
      error.status,
    );
  if (error instanceof WalletRpcError || error instanceof WarmupQuoteError)
    return json(
      {
        error:
          'Read-only provider could not establish a fresh unsigned order. Recover the same preparation ID before retrying.',
      },
      error instanceof WalletRpcError && error.status === 429 ? 429 : 502,
    );
  return json(
    {
      error:
        'Unsigned preparation recovery is unavailable. Keep the original ID and recover before another write.',
    },
    503,
  );
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json(
      { error: 'Sign in to recover an unsigned session preparation.' },
      401,
    );
  const params = new URL(request.url).searchParams,
    id = uuid.safeParse(params.get('id'));
  if (
    !id.success ||
    params.getAll('id').length !== 1 ||
    [...params.keys()].some((k) => k !== 'id')
  )
    return json({ error: 'Choose one saved preparation ID.' }, 400);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
  try {
    signal.throwIfAborted();
    const saved = await readWalletWarmupSessionPreparation(
      getD1(),
      user.userId,
      id.data,
      signal,
    );
    signal.throwIfAborted();
    return saved
      ? json({ preparation: project(saved) })
      : json(
          { error: 'Unsigned session preparation not found for this account.' },
          404,
        );
  } catch (error) {
    return failure(error, signal);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to prepare the saved session action.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin request required.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(WARMUP_SESSION_PREPARATION_TIMEOUT_MS),
  ]);
  try {
    signal.throwIfAborted();
    let selection: z.infer<typeof body>;
    try {
      selection = body.parse(
        await walletRequest(new Request(request, { signal }), 2048),
      );
    } catch (error) {
      if (signal.aborted) return cancelled();
      const large =
        error instanceof Error && error.message === 'Wallet request too large.';
      return json(
        {
          error: large
            ? 'Request too large.'
            : 'Choose the exact preparation request and explicitly request preparation.',
        },
        large ? 413 : 400,
      );
    }
    signal.throwIfAborted();
    const { prepareRequested: _requested, ...input } = selection,
      db = getD1();
    const key =
      typeof env.JUPITER_API_KEY === 'string' ? env.JUPITER_API_KEY : undefined;
    const saved = await prepareWalletWarmupSessionAction(
      db,
      user.userId,
      input,
      signal,
      createWalletWarmupSessionProvider(db, user.userId, key),
    );
    signal.throwIfAborted();
    return json({ preparation: project(saved) });
  } catch (error) {
    return failure(error, signal);
  }
}
