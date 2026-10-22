import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  readWalletFundingTimes,
  WalletFundingTimeError,
} from '@/lib/wallet-funding-time-server';
import { walletFundingSelection } from '@/lib/wallet-funding-time';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
async function readBody(request: Request, signal: AbortSignal) {
  const reader = request.body?.getReader();
  if (!reader) throw Error();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0,
    text = '',
    finished = false;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) {
        finished = true;
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > 12000) throw new WalletFundingTimeError(413);
      text += decoder.decode(next.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}
/** Authenticated SELECT-only read. Never creates funding or provider work. */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to check recorded funding times.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin request required.' }, 403);
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get('content-type') ?? '',
    )
  )
    return json({ error: 'JSON required.' }, 415);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
  try {
    let selection;
    try {
      selection = walletFundingSelection.parse(await readBody(request, signal));
    } catch (e) {
      if (e instanceof WalletFundingTimeError || signal.aborted) throw e;
      return json(
        {
          error:
            'Choose up to 100 distinct active Solana wallets and their current revisions.',
        },
        400,
      );
    }
    return json(
      await readWalletFundingTimes(getD1(), user.userId, selection, signal),
    );
  } catch (e) {
    return json(
      {
        error:
          'Recorded funding times unavailable. Keep your selection and retry this read.',
      },
      signal.aborted
        ? 408
        : e instanceof WalletFundingTimeError
          ? e.status
          : 503,
    );
  }
}
