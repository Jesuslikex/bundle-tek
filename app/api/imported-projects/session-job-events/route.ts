import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { UUID } from '@/lib/wallet-operation';
import {
  decodeSessionJobEvent,
  type SessionJobEvent,
} from '@/lib/session-preparation-job-events';
export const dynamic = 'force-dynamic';
const json = (b: unknown, status = 200) =>
  Response.json(b, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to view preparation job history.' }, 401);
  const q = new URL(request.url).searchParams,
    p = q.get('projectId'),
    s = q.get('sessionId'),
    cursor = q.get('cursor');
  if (
    (p !== null && !UUID.test(p)) ||
    (s !== null && !UUID.test(s)) ||
    (s && !p) ||
    (cursor !== null && !/^[a-f0-9]{32}$/.test(cursor))
  )
    return json({ error: 'Choose a valid job history context.' }, 400);
  try {
    const db = getD1(),
      owner = user.userId;
    if (
      p &&
      !(await db
        .prepare(
          'SELECT id FROM imported_token_projects WHERE owner_id=? AND id=?',
        )
        .bind(owner, p)
        .first())
    )
      return json({ error: 'Project unavailable.' }, 404);
    if (
      s &&
      !(await db
        .prepare(
          'SELECT id FROM imported_trade_sessions WHERE owner_id=? AND project_id=? AND id=?',
        )
        .bind(owner, p, s)
        .first())
    )
      return json({ error: 'Session unavailable.' }, 404);
    const scope =
      'owner_id=? AND (? IS NULL OR project_id=?) AND (? IS NULL OR session_id=?)';
    const anchor = cursor
      ? await db
          .prepare(
            'SELECT sequence FROM session_preparation_job_events WHERE ' +
              scope +
              ' AND id=?',
          )
          .bind(owner, p, p, s, s, cursor)
          .first<{ sequence: number }>()
      : null;
    if (cursor && !anchor)
      return json({ error: 'Owned job history cursor unavailable.' }, 400);
    const rows = await db
      .prepare(
        'SELECT id,sequence,project_id AS projectId,session_id AS sessionId,job_id AS jobId,document,created_at AS createdAt FROM session_preparation_job_events WHERE ' +
          scope +
          ' AND sequence<? ORDER BY sequence DESC LIMIT 51',
      )
      .bind(owner, p, p, s, s, anchor?.sequence ?? Number.MAX_SAFE_INTEGER)
      .all<
        Omit<SessionJobEvent, 'document'> & {
          document: string;
        }
      >();
    const events = rows.results.slice(0, 50).map((r) =>
      decodeSessionJobEvent({
        ...r,
        document: JSON.parse(r.document),
      }),
    );
    return json({
      events,
      nextCursor: rows.results.length > 50 ? events.at(-1)!.id : null,
    });
  } catch {
    return json({ error: 'Preparation job history unavailable.' }, 503);
  }
}
