import { z } from 'zod';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import {
  readWalletWarmupV2Consent,
  reviewWalletWarmupV2Consent,
  retainWalletWarmupV2Consent,
  WalletWarmupV2ConsentError,
} from '@/lib/wallet-warmup-session-v2-consent';
export const dynamic = 'force-dynamic';
const uuid = z.uuid().refine((v) => v === v.toLowerCase()),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const fields = {
  reviewId: uuid,
  reviewSha256: hash,
  sessionExpiresAt: z.iso.datetime(),
};
const body = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('review'), ...fields }).strict(),
  z
    .object({
      operation: z.literal('save'),
      ...fields,
      id: uuid,
      termsSha256: hash,
      approved: z.literal(true),
    })
    .strict(),
]);
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
function failure(error: unknown, signal: AbortSignal) {
  if (signal.aborted)
    return json(
      {
        error:
          'Request ended before confirmation. Recover the original versioned approval ID before another save.',
        ...(error instanceof WalletWarmupV2ConsentError && error.recoveryId
          ? { recoveryId: error.recoveryId }
          : {}),
      },
      408,
    );
  if (error instanceof z.ZodError)
    return json(
      {
        error: 'Choose and separately approve the exact versioned plan terms.',
      },
      400,
    );
  if (error instanceof WalletWarmupV2ConsentError)
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
        'Versioned approval is unavailable. Keep the original ID and recover before another save.',
    },
    503,
  );
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json(
      { error: 'Sign in to recover a versioned plan approval.' },
      401,
    );
  const params = new URL(request.url).searchParams,
    id = uuid.safeParse(params.get('id'));
  if (
    !id.success ||
    params.getAll('id').length !== 1 ||
    [...params.keys()].some((k) => k !== 'id')
  )
    return json({ error: 'Choose one original versioned approval ID.' }, 400);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
  try {
    signal.throwIfAborted();
    const consent = await readWalletWarmupV2Consent(
      getD1(),
      user.userId,
      id.data,
      signal,
    );
    signal.throwIfAborted();
    return consent
      ? json({ consent })
      : json({ error: 'Versioned approval not found for this account.' }, 404);
  } catch (error) {
    return failure(error, signal);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to review versioned plan terms.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin request required.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
  try {
    signal.throwIfAborted();
    let input: z.infer<typeof body>;
    try {
      input = body.parse(await walletRequest(request, 2048, signal));
    } catch (error) {
      if (signal.aborted) return failure(error, signal);
      const large =
        error instanceof Error && error.message === 'Wallet request too large.';
      return json(
        {
          error: large
            ? 'Request too large.'
            : 'Choose and separately approve the exact versioned plan terms.',
        },
        large ? 413 : 400,
      );
    }
    signal.throwIfAborted();
    const db = getD1();
    if (input.operation === 'review') {
      const { operation: _operation, ...value } = input;
      const consentReview = await reviewWalletWarmupV2Consent(
        db,
        user.userId,
        value,
        signal,
      );
      signal.throwIfAborted();
      return json({ consentReview });
    }
    const { operation: _operation, approved, ...selection } = input;
    const consent = await retainWalletWarmupV2Consent(
      db,
      user.userId,
      selection,
      approved,
      signal,
    );
    signal.throwIfAborted();
    return json({ consent });
  } catch (error) {
    return failure(error, signal);
  }
}
