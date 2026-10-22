import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { WalletWarmupV2JournalClockAheadError } from '@/lib/wallet-warmup-session-v2-journal';
import {
  WARMUP_HISTORY_CLOCK_CODE,
  WARMUP_HISTORY_CLOCK_MESSAGE,
} from '@/lib/warmup-history-clock';
import {
  warmupAttemptUuid,
  WalletWarmupV2AttemptError,
} from '@/lib/wallet-warmup-session-v2-attempt-types';
import {
  readWalletWarmupV2ReadAttempt,
  listWalletWarmupV2ReadAttempts,
} from '@/lib/wallet-warmup-session-v2-attempts';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
/** Saved-only, mode-aware discovery. No provider request, write or deadline renewal. */
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to recover saved warmup checks.' }, 401);
  const params = new URL(request.url).searchParams,
    listing = params.has('journalId'),
    key = listing ? 'journalId' : 'id';
  const id = warmupAttemptUuid.safeParse(params.get(key)),
    text = params.get('before');
  const before =
    text === null ? null : /^[1-9]\d{0,4}$/.test(text) ? Number(text) : NaN;
  if (
    !id.success ||
    params.getAll(key).length !== 1 ||
    params.getAll('before').length > 1 ||
    (listing
      ? before !== null &&
        (!Number.isSafeInteger(before) || before < 1 || before > 14400)
      : params.has('before')) ||
    [...params.keys()].some(
      (k) => !(listing ? ['journalId', 'before'] : ['id']).includes(k),
    )
  )
    return json(
      { error: 'Choose one original saved check or history page.' },
      400,
    );
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
  try {
    const value = listing
      ? {
          page: await listWalletWarmupV2ReadAttempts(
            getD1(),
            user.userId,
            id.data,
            before,
            signal,
          ),
        }
      : await readWalletWarmupV2ReadAttempt(
          getD1(),
          user.userId,
          id.data,
          signal,
        );
    signal.throwIfAborted();
    return value
      ? json(value)
      : json({ error: 'Saved check not found for this account.' }, 404);
  } catch (error) {
    if (signal.aborted)
      return json(
        {
          error:
            'Recovery ended before confirmation. Keep the original ID and recover it again.',
        },
        408,
      );
    if (error instanceof WalletWarmupV2JournalClockAheadError)
      return json(
        {
          code: WARMUP_HISTORY_CLOCK_CODE,
          error: WARMUP_HISTORY_CLOCK_MESSAGE,
        },
        409,
      );
    if (error instanceof WalletWarmupV2AttemptError)
      return json({ error: error.message }, error.status);
    return json(
      { error: 'Saved checks could not be verified. Keep their original IDs.' },
      503,
    );
  }
}
