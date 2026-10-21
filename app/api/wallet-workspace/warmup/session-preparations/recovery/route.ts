import { z } from 'zod';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  readWalletWarmupSessionPreparationRecovery,
  findWalletWarmupSessionPreparationRecovery,
} from '@/lib/wallet-warmup-session-preparation-recovery';
export const dynamic = 'force-dynamic';
const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
/** Saved-only recovery. No provider configuration, write, renewal or execution. */
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json(
      { error: 'Sign in to recover a saved unsigned preparation.' },
      401,
    );
  const params = new URL(request.url).searchParams,
    byJournal = params.has('journalId'),
    key = byJournal ? 'journalId' : 'id',
    id = uuid.safeParse(params.get(key));
  if (
    !id.success ||
    params.getAll(key).length !== 1 ||
    [...params.keys()].some((k) => k !== key)
  )
    return json({ error: 'Choose one original preparation ID.' }, 400);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
  try {
    signal.throwIfAborted();
    const recovery = await (
      byJournal
        ? findWalletWarmupSessionPreparationRecovery
        : readWalletWarmupSessionPreparationRecovery
    )(getD1(), user.userId, id.data, signal);
    signal.throwIfAborted();
    return recovery
      ? json({ recovery })
      : json(
          { error: 'Saved unsigned preparation not found for this account.' },
          404,
        );
  } catch {
    return json(
      {
        error: signal.aborted
          ? 'Recovery request ended. Keep the original ID and recover again.'
          : 'Saved unsigned preparation context is unavailable or differs. Nothing was renewed or sent.',
      },
      signal.aborted ? 408 : 503,
    );
  }
}
