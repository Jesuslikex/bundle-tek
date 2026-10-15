import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { ImportedPairQuoteError } from '@/lib/imported-pair-quote-service';
import {
  importedPairRuntimeRequest,
  previewOwnedImportedPairRuntime,
} from '@/lib/imported-pair-runtime';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(status === 429 ? { 'retry-after': '15' } : {}),
    },
  });
async function body(request: Request) {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3000)]),
    reader = request.body?.getReader();
  if (!reader) throw new ImportedPairQuoteError('JSON request required.', 400);
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      void reader.cancel().catch(() => {});
      reject(
        new ImportedPairQuoteError(
          'Pair runtime request timed out or was cancelled.',
          408,
        ),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  void interrupted.catch(() => {});
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0,
      text = '';
    while (true) {
      signal.throwIfAborted();
      const chunk = await Promise.race([reader.read(), interrupted]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2048)
        throw new ImportedPairQuoteError(
          'Pair runtime request is too large.',
          413,
        );
      text += decoder.decode(chunk.value, { stream: true });
    }
    signal.throwIfAborted();
    text += decoder.decode();
    return importedPairRuntimeRequest(JSON.parse(text));
  } catch (error) {
    if (error instanceof ImportedPairQuoteError) throw error;
    if (signal.aborted)
      throw new ImportedPairQuoteError(
        'Pair runtime request timed out or was cancelled.',
        408,
      );
    throw new ImportedPairQuoteError(
      'Use valid UTF-8 JSON for this pair runtime request.',
      400,
    );
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json(
      { error: 'Sign in to prepare a wallet-bound pair runtime.' },
      401,
    );
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin request rejected.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  if (new URL(request.url).searchParams.size)
    return json({ error: 'Unexpected pair runtime query parameters.' }, 400);
  try {
    const input = await body(request);
    return json(
      await previewOwnedImportedPairRuntime(
        getD1(),
        user.userId,
        input,
        request.signal,
      ),
    );
  } catch (error) {
    if (error instanceof ImportedPairQuoteError)
      return json({ error: error.message }, error.status);
    return json(
      {
        error:
          'Unsigned pair runtime unavailable. No approval, reservation or signature was created.',
      },
      502,
    );
  }
}
