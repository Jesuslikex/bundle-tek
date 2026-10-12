import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to read project activity.' }, 401);
  const cursor = new URL(request.url).searchParams.get('cursor');
  if (
    cursor !== null &&
    (!/^[1-9]\d{0,15}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
  )
    return json({ error: 'Invalid project history cursor.' }, 400);
  try {
    const result = await getD1()
      .prepare(`SELECT id,project_id AS projectId,name,chain,launchpad,type,changes,revision,created_at AS createdAt
      FROM project_events WHERE owner_id=? AND id<? ORDER BY id DESC LIMIT 51`)
      .bind(user.userId, cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER)
      .all<{ id: number; changes: string }>();
    const events = result.results
      .slice(0, 50)
      .map((row) => ({ ...row, changes: JSON.parse(row.changes) }));
    return json({
      events,
      nextCursor: result.results.length > 50 ? String(events.at(-1)!.id) : null,
    });
  } catch {
    return json({ error: 'Project history temporarily unavailable.' }, 503);
  }
}
