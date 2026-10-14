import { getD1 } from '@/db';
import { artworkIdValid } from '@/lib/artwork';
import { publicMetadataHeaders } from '../route';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!artworkIdValid(id)) return new Response(null, { status: 404 });
  try {
    const row = await getD1()
      .prepare('SELECT image,mime FROM launch_metadata_releases WHERE id=?')
      .bind(id)
      .first<{ image: number[]; mime: string }>();
    if (!row)
      return new Response(null, {
        status: 404,
        headers: { 'cache-control': 'no-store' },
      });
    return new Response(new Uint8Array(row.image), {
      headers: {
        ...publicMetadataHeaders,
        'content-type': row.mime,
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new Response(null, {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  }
}
