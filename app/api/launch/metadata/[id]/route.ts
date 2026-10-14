import { getD1 } from '@/db';
import { artworkIdValid } from '@/lib/artwork';
export const dynamic = 'force-dynamic';

export const publicMetadataHeaders = {
  'access-control-allow-origin': '*',
  'cross-origin-resource-policy': 'cross-origin',
  'x-content-type-options': 'nosniff',
};
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!artworkIdValid(id)) return new Response(null, { status: 404 });
  try {
    const row = await getD1()
      .prepare('SELECT metadata FROM launch_metadata_releases WHERE id=?')
      .bind(id)
      .first<{ metadata: string }>();
    if (!row)
      return new Response(null, {
        status: 404,
        headers: { 'cache-control': 'no-store' },
      });
    return new Response(row.metadata, {
      headers: {
        ...publicMetadataHeaders,
        'content-type': 'application/json; charset=utf-8',
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
