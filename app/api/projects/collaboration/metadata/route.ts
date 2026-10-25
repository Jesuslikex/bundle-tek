import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { readMetadataEditRequest } from '@/lib/project-collaboration-metadata';
import {
  getMetadataEditSource,
  saveMetadataEdit,
  readMetadataEditReceipt,
  ProjectMetadataEditError,
} from '@/lib/project-collaboration-metadata-storage';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const failed = (error: unknown) =>
  error instanceof ProjectMetadataEditError
    ? json({ error: error.message }, error.status)
    : json(
        {
          error:
            'Saved-text editing is temporarily unavailable. Check the original edit before starting another save.',
        },
        503,
      );

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to inspect saved-text edits.' }, 401);
  const params = new URL(request.url).searchParams;
  const keys = [...params.keys()];
  if (keys.length !== 1 || !['shareId', 'mutationId'].includes(keys[0]))
    return json({ error: 'Choose one exact share or edit ID.' }, 400);
  try {
    if (keys[0] === 'mutationId')
      return json({
        receipt: await readMetadataEditReceipt(
          getD1(),
          user.userId,
          params.get('mutationId')!,
        ),
      });
    return json(
      await getMetadataEditSource(getD1(), user.userId, params.get('shareId')!),
    );
  } catch (error) {
    return failed(error);
  }
}

class BodyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function readBody(request: Request, signal: AbortSignal) {
  const reader = request.body?.getReader();
  if (!reader) throw new BodyError('JSON required.', 400);
  let size = 0,
    text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        throw new BodyError('Saved-text request is too large.', 413);
      }
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to save reviewed text.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Cross-origin edit rejected.' }, 403);
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get('content-type') ?? '',
    )
  )
    return json({ error: 'JSON required.' }, 415);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
  let body: unknown;
  try {
    body = await readBody(request, signal);
  } catch (error) {
    return error instanceof BodyError
      ? json({ error: error.message }, error.status)
      : json({ error: 'The edit request was invalid or interrupted.' }, 400);
  }
  let edit;
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error();
    const { action, ...rest } = body as Record<string, unknown>;
    if (action !== 'save') throw Error();
    edit = readMetadataEditRequest(rest);
  } catch {
    return json(
      { error: 'Review and approve the exact saved-text changes first.' },
      400,
    );
  }
  try {
    return json(await saveMetadataEdit(getD1(), user.userId, edit, signal));
  } catch (error) {
    return failed(error);
  }
}
