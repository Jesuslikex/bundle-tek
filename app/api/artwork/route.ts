import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  inspectArtwork,
  MAX_ARTWORK_BYTES,
  MAX_ARTWORK_COUNT,
  MAX_ARTWORK_STORAGE,
  type SavedArtwork,
  artworkIdValid,
} from '@/lib/artwork';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request?: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to browse your artwork.' }, 401);
  const view = request ? new URL(request.url).searchParams.get('view') : null;
  if (view && !['active', 'archived'].includes(view))
    return json({ error: 'Choose an artwork view.' }, 400);
  try {
    const db = getD1();
    const [result, totals] = await db.batch([
      db
        .prepare(`SELECT a.id,a.mime,a.byte_length AS bytes,a.created_at AS createdAt,a.archived,a.revision,a.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM workspace_projects p WHERE p.owner_id=a.owner_id AND p.archived=0
        AND json_extract(CASE WHEN json_valid(p.document) THEN p.document ELSE '{}' END,'$.identity.artworkUrl')='/api/artwork/'||a.id) AS activeProjects,
      (SELECT COUNT(*) FROM workspace_projects p WHERE p.owner_id=a.owner_id AND p.archived=1
        AND json_extract(CASE WHEN json_valid(p.document) THEN p.document ELSE '{}' END,'$.identity.artworkUrl')='/api/artwork/'||a.id) AS archivedProjects
      FROM project_artwork a WHERE a.owner_id=? AND a.archived=? ORDER BY a.created_at DESC,a.id DESC LIMIT ?`)
        .bind(user.userId, view === 'archived' ? 1 : 0, MAX_ARTWORK_COUNT + 1),
      db
        .prepare(
          'SELECT COUNT(*) AS count,COALESCE(SUM(byte_length),0) AS bytes,SUM(archived) AS archivedCount FROM project_artwork WHERE owner_id=?',
        )
        .bind(user.userId),
    ]);
    const total = totals.results[0] as {
      count: number;
      bytes: number;
      archivedCount: number | null;
    };
    if (total.count > MAX_ARTWORK_COUNT)
      return json(
        { error: 'Artwork library exceeds the supported account limit.' },
        409,
      );
    const artwork = (
      result.results as unknown as Array<
        Omit<SavedArtwork, 'url' | 'archived'> & { archived: number }
      >
    ).map((row) => ({
      ...row,
      archived: row.archived === 1,
      url: `/api/artwork/${row.id}`,
    }));
    return json({
      artwork,
      usage: {
        count: total.count,
        bytes: total.bytes,
        archivedCount: total.archivedCount ?? 0,
        maxCount: MAX_ARTWORK_COUNT,
        maxBytes: MAX_ARTWORK_STORAGE,
      },
    });
  } catch {
    return json({ error: 'Artwork library temporarily unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to upload artwork.' }, 401);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return json({ error: 'Cross-origin upload rejected.' }, 403);
  if (
    !['image/png', 'image/jpeg'].includes(
      request.headers.get('content-type')?.toLowerCase() ?? '',
    )
  )
    return json({ error: 'Upload a PNG or JPEG image.' }, 415);
  const size = request.headers.get('content-length');
  if (size && Number(size) > MAX_ARTWORK_BYTES)
    return json({ error: 'Choose an image up to 512 KB.' }, 413);
  const reader = request.body?.getReader();
  if (!reader) return json({ error: 'Choose an image.' }, 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_ARTWORK_BYTES) {
        await reader.cancel();
        return json({ error: 'Choose an image up to 512 KB.' }, 413);
      }
      chunks.push(value);
    }
  } catch {
    return json({ error: 'Image upload interrupted.' }, 400);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let image;
  try {
    image = inspectArtwork(bytes);
  } catch (error) {
    return json({ error: (error as Error).message }, 400);
  }
  const id = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  try {
    const db = getD1();
    const now = new Date().toISOString();
    await db
      .prepare(`INSERT INTO project_artwork (owner_id,id,data,mime,byte_length,created_at,updated_at)
      SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM project_artwork WHERE owner_id=?) < ?
      AND COALESCE((SELECT SUM(byte_length) FROM project_artwork WHERE owner_id=?),0) + ? <= ?
      ON CONFLICT(owner_id,id) DO NOTHING`)
      .bind(
        user.userId,
        id,
        bytes,
        image.mime,
        length,
        now,
        now,
        user.userId,
        MAX_ARTWORK_COUNT,
        user.userId,
        length,
        MAX_ARTWORK_STORAGE,
      )
      .run();
    const saved = await db
      .prepare(
        'SELECT id,archived,revision FROM project_artwork WHERE owner_id=? AND id=?',
      )
      .bind(user.userId, id)
      .first<{ id: string; archived: number; revision: number }>();
    if (!saved)
      return json(
        { error: 'Artwork storage is full. Use a hosted artwork URL for now.' },
        409,
      );
    return json({
      artwork: {
        id,
        url: `/api/artwork/${id}`,
        ...image,
        bytes: length,
        archived: saved.archived === 1,
        revision: saved.revision,
      },
    });
  } catch {
    return json({ error: 'Artwork storage temporarily unavailable.' }, 503);
  }
}

export async function PATCH(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to manage artwork.' }, 401);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin change rejected.' }, 403);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  let input: {
    id: string;
    expectedRevision: number;
    action: 'archive' | 'restore';
  };
  try {
    const text = await request.text();
    if (text.length > 300) return json({ error: 'Request too large.' }, 413);
    input = JSON.parse(text);
    if (
      !input ||
      typeof input.id !== 'string' ||
      !artworkIdValid(input.id) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      input.expectedRevision >= 1000000000 ||
      !['archive', 'restore'].includes(input.action)
    )
      throw new Error();
  } catch {
    return json(
      {
        error:
          'Choose artwork, its current revision and an archive or restore action.',
      },
      400,
    );
  }
  try {
    const result = await getD1()
      .prepare(
        `UPDATE project_artwork SET archived=?,revision=revision+1,updated_at=? WHERE owner_id=? AND id=? AND revision=? AND archived=?`,
      )
      .bind(
        input.action === 'archive' ? 1 : 0,
        new Date().toISOString(),
        user.userId,
        input.id,
        input.expectedRevision,
        input.action === 'archive' ? 0 : 1,
      )
      .run();
    if (!result.meta.changes)
      return json(
        { error: 'Artwork changed or is unavailable. Reload the library.' },
        409,
      );
    return json({
      id: input.id,
      revision: input.expectedRevision + 1,
      archived: input.action === 'archive',
    });
  } catch {
    return json({ error: 'Artwork change temporarily unavailable.' }, 503);
  }
}
