import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to read funding activity.' }, 401);
  const raw = new URL(request.url).searchParams.get('cursor');
  if (
    raw !== null &&
    (!/^[1-9]\d{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw)))
  )
    return json({ error: 'Invalid activity cursor.' }, 400);
  try {
    const results = await getD1()
      .prepare(`SELECT id,plan_id AS planId,name,chain,type,revision,created_at AS createdAt FROM funding_events
      WHERE owner_id=? AND id<? ORDER BY id DESC LIMIT 51`)
      .bind(user.userId, raw ? Number(raw) : Number.MAX_SAFE_INTEGER)
      .all<{ id: number }>();
    const events = results.results.slice(0, 50);
    return json({
      events,
      nextCursor:
        results.results.length > 50 ? String(events.at(-1)!.id) : null,
    });
  } catch {
    return json({ error: 'Funding activity temporarily unavailable.' }, 503);
  }
}
