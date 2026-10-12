import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to read warmup history.' }, 401);
  const query = new URL(request.url).searchParams;
  const id = query.get('id'),
    cursor = query.get('cursor');
  if (
    !id ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(id) ||
    (cursor !== null && !/^[1-9]\d{0,8}$/.test(cursor))
  )
    return json(
      { error: 'Choose a warmup plan and valid history cursor.' },
      400,
    );
  try {
    const db = getD1();
    const plan = await db
      .prepare(
        'SELECT revision FROM wallet_warmup_plans WHERE owner_id=? AND id=?',
      )
      .bind(user.userId, id)
      .first<{ revision: number }>();
    if (!plan) return json({ error: 'Warmup plan not found.' }, 404);
    const rows = await db
      .prepare(
        'SELECT id,plan_id AS planId,type,revision,document,created_at AS createdAt FROM wallet_warmup_plan_events WHERE owner_id=? AND plan_id=? AND revision<=? AND revision<? ORDER BY revision DESC LIMIT 51',
      )
      .bind(
        user.userId,
        id,
        plan.revision,
        cursor ? Number(cursor) : 1000000000,
      )
      .all<{
        id: string;
        planId: string;
        type: string;
        revision: number;
        document: string;
        createdAt: string;
      }>();
    const events = rows.results
      .slice(0, 50)
      .map((row) => ({ ...row, document: JSON.parse(row.document) }));
    return json({
      planId: id,
      revision: plan.revision,
      events,
      nextCursor:
        rows.results.length > 50 ? String(events.at(-1)!.revision) : null,
    });
  } catch {
    return json({ error: 'Warmup history unavailable.' }, 503);
  }
}
