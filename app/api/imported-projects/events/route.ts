import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to read imported project history.' }, 401);
  const query = new URL(request.url).searchParams;
  const id = query.get('id'),
    cursor = query.get('cursor');
  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      id,
    ) ||
    (cursor !== null &&
      (!/^[1-9]\d{0,15}$/.test(cursor) ||
        !Number.isSafeInteger(Number(cursor))))
  )
    return json(
      { error: 'Choose an imported project and valid history cursor.' },
      400,
    );
  try {
    const db = getD1();
    const project = await db
      .prepare(
        'SELECT revision FROM imported_token_projects WHERE owner_id=? AND id=?',
      )
      .bind(user.userId, id)
      .first<{ revision: number }>();
    if (!project) return json({ error: 'Imported project not found.' }, 404);
    const rows = await db
      .prepare(
        'SELECT id,project_id AS projectId,type,revision,document,created_at AS createdAt FROM imported_token_project_events WHERE owner_id=? AND project_id=? AND revision<=? AND revision<? ORDER BY revision DESC LIMIT 51',
      )
      .bind(
        user.userId,
        id,
        project.revision,
        cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER,
      )
      .all<{
        id: string;
        projectId: string;
        type: string;
        revision: number;
        document: string;
        createdAt: string;
      }>();
    const events = rows.results
      .slice(0, 50)
      .map((row) => ({ ...row, document: JSON.parse(row.document) }));
    return json({
      projectId: id,
      revision: project.revision,
      events,
      nextCursor:
        rows.results.length > 50 ? String(events.at(-1)!.revision) : null,
    });
  } catch {
    return json({ error: 'Imported project history unavailable.' }, 503);
  }
}
