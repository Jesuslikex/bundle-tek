import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { readOwnedLayerNativeEvidence } from '@/lib/launch-layer-native-service';
import {
  LaunchLayerError,
  listOwnedLaunchLayerPlans,
  readLaunchLayerContext,
  readOwnedLaunchLayerPlan,
  saveOwnedLaunchLayerPlan,
} from '@/lib/launch-layer-service';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const failure = (error: unknown) =>
  error instanceof LaunchLayerError
    ? json({ error: error.message }, error.status)
    : json(
        {
          error:
            'Launch layer planning is unavailable. No funding or launch settings changed.',
        },
        503,
      );
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to read saved launch layers.' }, 401);
  const p = new URL(request.url).searchParams;
  try {
    if (
      p.size === 3 &&
      p.has('projectId') &&
      p.has('id') &&
      p.get('balances') === '1'
    )
      return json({
        evidence: await readOwnedLayerNativeEvidence(
          getD1(),
          user.userId,
          p.get('projectId')!,
          p.get('id')!,
        ),
      });
    if (p.size === 1 && p.has('history'))
      return json({
        history: await listOwnedLaunchLayerPlans(
          getD1(),
          user.userId,
          p.get('history')!,
        ),
      });
    if (p.size === 1 && p.has('context')) {
      const text = p.get('context')!;
      if (new TextEncoder().encode(text).byteLength > 2048)
        return json({ error: 'Planning selection is too large.' }, 413);
      let selection: unknown;
      try {
        selection = JSON.parse(text);
      } catch {
        return json({ error: 'Choose a valid planning selection.' }, 400);
      }
      return json({
        context: await readLaunchLayerContext(getD1(), user.userId, selection),
      });
    }
    if (p.has('projectId') && (p.size === 1 || (p.size === 2 && p.has('id'))))
      return json({
        plan: await readOwnedLaunchLayerPlan(
          getD1(),
          user.userId,
          p.get('projectId')!,
          p.get('id') ?? undefined,
        ),
      });
    return json(
      { error: 'Choose one owned saved project or exact planning context.' },
      400,
    );
  } catch (error) {
    return failure(error);
  }
}
const MAX_BODY = 262144;
async function body(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new LaunchLayerError('JSON is required.', 400);
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      count += r.value.byteLength;
      if (count > MAX_BODY) {
        await reader.cancel();
        throw new LaunchLayerError('Layer plan is too large.', 413);
      }
      chunks.push(r.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new LaunchLayerError('Valid JSON is required.', 400);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to save launch layer planning.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin request required.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  try {
    const value = await body(request);
    request.signal.throwIfAborted();
    return json({
      plan: await saveOwnedLaunchLayerPlan(
        getD1(),
        user.userId,
        value,
        Date.now,
        request.signal,
      ),
    });
  } catch (error) {
    if (request.signal.aborted)
      return json({ error: 'Planning request cancelled.' }, 408);
    return failure(error);
  }
}
