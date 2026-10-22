import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  readOwnedFundingOrigins,
  FundingOriginReadError,
} from '@/lib/wallet-funding-origin-server';
import { fundingOriginBatchSelection } from '@/lib/wallet-funding-origin-view';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(status === 429 ? { 'retry-after': '60' } : {}),
    },
  });
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
      if (bytes > 12000) throw new FundingOriginReadError(413);
      text += decoder.decode(next.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}
/** Authenticated explicit provider read. Gate bookkeeping only; never funds or signs. */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to check provider funding history.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin request required.' }, 403);
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get('content-type') ?? '',
    )
  )
    return json({ error: 'JSON required.' }, 415);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45000)]);
  try {
    let selection;
    try {
      selection = fundingOriginBatchSelection.parse(
        await readBody(request, signal),
      );
    } catch (e) {
      if (e instanceof FundingOriginReadError || signal.aborted) throw e;
      return json(
        {
          error:
            'Choose up to 10 active Solana wallets and the full selection of up to 100 current revisions.',
        },
        400,
      );
    }
    const result = await readOwnedFundingOrigins(
      getD1(),
      user.userId,
      selection,
      signal,
    );
    signal.throwIfAborted();
    return json(result);
  } catch (e) {
    return json(
      {
        error:
          'Provider funding history unavailable. Wait at least 15 seconds before a new check; provider limits can last longer. No automatic retry was made.',
      },
      signal.aborted
        ? 408
        : e instanceof FundingOriginReadError
          ? e.status
          : 503,
    );
  }
}
