import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  CounterPreviewError,
  counterPreviewRequest,
  previewOwnedCounterBuyRuntime,
} from '@/lib/counter-owned-preview';
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
  if (!reader) throw new CounterPreviewError('JSON request required.', 400);
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      void reader.cancel().catch(() => {});
      reject(
        new CounterPreviewError(
          'Counter runtime preview request timed out or was cancelled.',
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
        throw new CounterPreviewError(
          'Counter runtime preview request is too large.',
          413,
        );
      text += decoder.decode(chunk.value, { stream: true });
    }
    signal.throwIfAborted();
    text += decoder.decode();
    return counterPreviewRequest(JSON.parse(text));
  } catch (error) {
    if (error instanceof CounterPreviewError) throw error;
    if (signal.aborted)
      throw new CounterPreviewError(
        'Counter runtime preview request timed out or was cancelled.',
        408,
      );
    throw new CounterPreviewError(
      'Use valid UTF-8 JSON for this Counter runtime preview request.',
      400,
    );
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
  }
}
/** Explicit runtime identity preview only; the shared rate gate is the only write. */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json(
      { error: 'Sign in to check owned Counter runtime evidence.' },
      401,
    );
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin request required.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  if (new URL(request.url).searchParams.size)
    return json({ error: 'Unexpected query parameters.' }, 400);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45000)]);
  try {
    const input = await body(request);
    signal.throwIfAborted();
    const db = getD1(),
      now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
      )
      .bind(user.userId, now + 15000, now)
      .run();
    signal.throwIfAborted();
    if (!gate.meta.changes)
      return json({ error: 'Wait 15 seconds between provider previews.' }, 429);
    const result = await previewOwnedCounterBuyRuntime(
      db,
      user.userId,
      input,
      signal,
    );
    signal.throwIfAborted();
    return json(result);
  } catch (error) {
    if (signal.aborted)
      return json(
        { error: 'Counter runtime preview cancelled or timed out.' },
        408,
      );
    if (error instanceof CounterPreviewError)
      return json({ error: error.message }, error.status);
    return json(
      {
        error:
          'Counter runtime preview unavailable. No budget claim or approval was created.',
      },
      502,
    );
  }
}
