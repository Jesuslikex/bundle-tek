import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { artworkIdValid } from '@/lib/artwork';
export const dynamic = 'force-dynamic';
const headers = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
};
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getChatGPTUser();
  if (!user) return new Response(null, { status: 401, headers });
  const { id } = await context.params;
  if (!artworkIdValid(id)) return new Response(null, { status: 404, headers });
  try {
    const row = await getD1()
      .prepare(
        'SELECT data,mime FROM project_artwork WHERE owner_id=? AND id=?',
      )
      .bind(user.userId, id)
      .first<{ data: number[]; mime: string }>();
    if (!row) return new Response(null, { status: 404, headers });
    return new Response(new Uint8Array(row.data), {
      headers: { ...headers, 'content-type': row.mime },
    });
  } catch {
    return new Response(null, { status: 503, headers });
  }
}
