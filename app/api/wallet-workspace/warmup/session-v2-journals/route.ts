import { z } from 'zod';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import {
  readWalletWarmupV2Journal,
  retainWalletWarmupV2Journal,
  appendWalletWarmupV2Journal,
  publicWalletWarmupV2Journal,
  WalletWarmupV2JournalError,
  warmupV2Control,
} from '@/lib/wallet-warmup-session-v2-journal';
export const dynamic = 'force-dynamic';
const uuid = z.uuid().refine((v) => v === v.toLowerCase()),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const body = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('record'),
      id: uuid,
      consentId: uuid,
      termsSha256: hash,
      recordRequested: z.literal(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal('control'),
      id: uuid,
      journalId: uuid,
      version: z.number().int().min(0).max(65535),
      headSha256: hash,
      control: warmupV2Control,
    })
    .strict(),
]);
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
function failure(error: unknown, signal: AbortSignal) {
  const hint =
    error instanceof WalletWarmupV2JournalError && error.recoveryId
      ? { recoveryId: error.recoveryId }
      : {};
  if (signal.aborted)
    return json(
      {
        error:
          'Request ended before confirmation. Recover the original history and event IDs before another write.',
        ...hint,
      },
      408,
    );
  if (error instanceof z.ZodError)
    return json(
      { error: 'Choose the exact saved history and original request.' },
      400,
    );
  if (error instanceof WalletWarmupV2JournalError)
    return json({ error: error.message, ...hint }, error.status);
  return json(
    {
      error:
        'Saved history is unavailable. Recover the original IDs before another write.',
    },
    503,
  );
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to recover warmup history.' }, 401);
  const params = new URL(request.url).searchParams,
    id = uuid.safeParse(params.get('id')),
    eventId = params.has('eventId')
      ? uuid.safeParse(params.get('eventId'))
      : null;
  if (
    !id.success ||
    (eventId && !eventId.success) ||
    params.getAll('id').length !== 1 ||
    params.getAll('eventId').length > 1 ||
    [...params.keys()].some((k) => !['id', 'eventId'].includes(k))
  )
    return json(
      { error: 'Choose one original history ID and optional event ID.' },
      400,
    );
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
  try {
    signal.throwIfAborted();
    const saved = await readWalletWarmupV2Journal(
      getD1(),
      user.userId,
      id.data,
      signal,
    );
    signal.throwIfAborted();
    return saved
      ? json({
          journal: publicWalletWarmupV2Journal(
            saved,
            eventId?.success ? eventId.data : undefined,
          ),
        })
      : json({ error: 'History not found for this account.' }, 404);
  } catch (error) {
    return failure(error, signal);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to record warmup history.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin request required.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
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
            : 'Choose the exact saved history and original request.',
        },
        large ? 413 : 400,
      );
    }
    signal.throwIfAborted();
    const db = getD1();
    if (input.operation === 'record') {
      const { operation: _operation, recordRequested, ...selection } = input;
      const saved = await retainWalletWarmupV2Journal(
        db,
        user.userId,
        selection,
        recordRequested,
        signal,
      );
      signal.throwIfAborted();
      return json({ journal: publicWalletWarmupV2Journal(saved) });
    }
    const { operation: _operation, ...selection } = input;
    const saved = await appendWalletWarmupV2Journal(
      db,
      user.userId,
      selection,
      signal,
    );
    signal.throwIfAborted();
    return json({ journal: publicWalletWarmupV2Journal(saved, input.id) });
  } catch (error) {
    return failure(error, signal);
  }
}
