import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  CounterPreviewError,
  counterPreviewRequest,
  previewOwnedCounterBuy,
} from '@/lib/counter-owned-preview';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
/** Explicit read-only Counter preview. Never creates signing intents or sends packets. */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to preview a Counter proposal.' }, 401);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin request rejected.' }, 403);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  try {
    const text = await request.text();
    if (text.length > 2048) return json({ error: 'Request too large.' }, 413);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return json({ error: 'Valid JSON required.' }, 400);
    }
    const input = counterPreviewRequest(value),
      db = getD1(),
      now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
      )
      .bind(user.userId, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      return json({ error: 'Wait 15 seconds between provider previews.' }, 429);
    const preview = await previewOwnedCounterBuy(
      db,
      user.userId,
      input,
      AbortSignal.any([request.signal, AbortSignal.timeout(45000)]),
    );
    return json({ preview });
  } catch (error) {
    if (request.signal.aborted)
      return json({ error: 'Counter preview cancelled.' }, 408);
    if (error instanceof CounterPreviewError)
      return json({ error: error.message }, error.status);
    return json(
      {
        error:
          'Counter preview unavailable. Reload saved history before retrying.',
      },
      502,
    );
  }
}
