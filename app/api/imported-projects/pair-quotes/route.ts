import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  ImportedPairQuoteError,
  importedPairQuoteRequest,
  quoteOwnedImportedPair,
} from '@/lib/imported-pair-quote-service';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
async function readPairQuoteBody(request: Request, signal: AbortSignal) {
  const reader = request.body?.getReader();
  if (!reader) throw new ImportedPairQuoteError('JSON request required.', 400);
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      void reader.cancel().catch(() => {});
      reject(
        new ImportedPairQuoteError(
          'Pair quote request timed out or was cancelled.',
          408,
        ),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  void interrupted.catch(() => {});
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0,
    text = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await Promise.race([reader.read(), interrupted]);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1600)
        throw new ImportedPairQuoteError(
          'Pair quote request is too large.',
          413,
        );
      text += decoder.decode(part.value, { stream: true });
    }
    signal.throwIfAborted();
    text += decoder.decode();
    try {
      return importedPairQuoteRequest(JSON.parse(text));
    } catch (error) {
      if (error instanceof ImportedPairQuoteError) throw error;
      throw new ImportedPairQuoteError(
        'Choose a valid current token pair and amount.',
        400,
      );
    }
  } catch (error) {
    if (error instanceof ImportedPairQuoteError) throw error;
    if (signal.aborted)
      throw new ImportedPairQuoteError(
        'Pair quote request timed out or was cancelled.',
        408,
      );
    throw new ImportedPairQuoteError(
      'Use valid UTF-8 JSON for this pair quote.',
      400,
    );
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to quote this token pair.' }, 401);
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
    return json({ error: 'Unexpected pair quote query parameters.' }, 400);
  try {
    const input = await readPairQuoteBody(
      request,
      AbortSignal.any([request.signal, AbortSignal.timeout(3000)]),
    );
    return json(
      await quoteOwnedImportedPair(getD1(), user.userId, input, request.signal),
    );
  } catch (error) {
    if (error instanceof ImportedPairQuoteError)
      return json({ error: error.message }, error.status);
    return json(
      {
        error:
          'Pair quote unavailable. No wallet balance was checked and no transaction was prepared, signed or submitted.',
      },
      502,
    );
  }
}
