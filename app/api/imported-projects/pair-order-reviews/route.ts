import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { ImportedPairQuoteError } from '@/lib/imported-pair-quote-service';
import {
  pairOrderFirstRequest,
  prepareOwnedPairOrderFirstReview,
  approveOwnedPairOrderFirstReview,
} from '@/lib/pair-order-first-service';
import type { PairOrderFirstConsent } from '@/lib/pair-order-first-review';
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
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new ImportedPairQuoteError('JSON required.', 400);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3000)]);
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    let size = 0,
      text = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4096)
        throw new ImportedPairQuoteError(
          'Order review request too large.',
          413,
        );
      text += decoder.decode(chunk.value, { stream: true });
    }
    const value: unknown = JSON.parse(text + decoder.decode());
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw Error();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ImportedPairQuoteError) throw error;
    throw new ImportedPairQuoteError(
      signal.aborted
        ? 'Order review request cancelled or timed out.'
        : 'Valid UTF-8 JSON required.',
      signal.aborted ? 408 : 400,
    );
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to review a pair order.' }, 401);
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
    return json({ error: 'Unexpected query parameters.' }, 400);
  try {
    const body = await readBody(request);
    if (
      body.action === 'prepare' &&
      Object.keys(body).sort().join(',') === 'action,request'
    )
      return json(
        await prepareOwnedPairOrderFirstReview(
          getD1(),
          user.userId,
          pairOrderFirstRequest(body.request),
          request.signal,
        ),
      );
    if (
      body.action === 'approve' &&
      Object.keys(body).sort().join(',') === 'action,consent,id' &&
      typeof body.id === 'string'
    )
      return json(
        await approveOwnedPairOrderFirstReview(
          getD1(),
          user.userId,
          body.id,
          body.consent as PairOrderFirstConsent,
          Date.now(),
          request.signal,
        ),
      );
    return json(
      { error: 'Choose explicit preparation or exact order approval.' },
      400,
    );
  } catch (error) {
    if (error instanceof ImportedPairQuoteError)
      return json({ error: error.message }, error.status);
    return json(
      {
        error:
          'Order review unavailable or changed. Request a new review. No signature or submission was made.',
      },
      409,
    );
  }
}
