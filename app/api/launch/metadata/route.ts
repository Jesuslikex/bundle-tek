import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  MetadataReleaseError,
  releaseLaunchMetadata,
} from '@/lib/launch-metadata-release';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to publish token metadata.' }, 401);
  const origin = new URL(request.url).origin;
  if (request.headers.get('origin') !== origin)
    return json({ error: 'Publish metadata from this site.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim() !==
    'application/json'
  )
    return json({ error: 'Send a JSON metadata publication request.' }, 415);
  const reader = request.body?.getReader();
  if (!reader) return json({ error: 'Review the saved project first.' }, 400);
  let body: Record<string, unknown>;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2048) {
        await reader.cancel();
        return json(
          { error: 'Metadata publication request is too large.' },
          413,
        );
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return json({ error: 'Send a valid metadata publication request.' }, 400);
  } finally {
    reader.releaseLock();
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).sort().join(',') !==
      'projectId,publishPublicly,updatedAt' ||
    body.publishPublicly !== true ||
    typeof body.projectId !== 'string' ||
    !body.projectId ||
    body.projectId.length > 128 ||
    typeof body.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(body.updatedAt))
  )
    return json(
      {
        error:
          'Explicitly approve public, permanent publication of the saved token details and artwork.',
      },
      400,
    );
  try {
    return json(
      await releaseLaunchMetadata(
        getD1(),
        user.userId,
        body.projectId,
        body.updatedAt,
        origin,
      ),
    );
  } catch (error) {
    if (error instanceof MetadataReleaseError)
      return json({ error: error.message }, error.status);
    return json(
      { error: 'Token metadata publication is temporarily unavailable.' },
      503,
    );
  }
}
