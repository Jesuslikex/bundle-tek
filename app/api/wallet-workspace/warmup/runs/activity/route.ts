import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import type { WarmupRunActivityEvent } from '@/lib/warmup-history-run-events';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to read warmup run activity.' }, 401);
  const raw = new URL(request.url).searchParams.get('cursor');
  let cursor: [string, string, number] | undefined;
  if (raw !== null) {
    try {
      if (raw.length > 160) throw new Error();
      const value: unknown = JSON.parse(raw);
      if (
        !Array.isArray(value) ||
        value.length !== 3 ||
        typeof value[0] !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value[0]) ||
        new Date(value[0]).toISOString() !== value[0] ||
        typeof value[1] !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          value[1],
        ) ||
        !Number.isSafeInteger(value[2]) ||
        value[2] < 1 ||
        value[2] > 1e9
      )
        throw new Error();
      cursor = [value[0], value[1], value[2]];
    } catch {
      return json({ error: 'Invalid warmup run activity cursor.' }, 400);
    }
  }
  try {
    const rows = await getD1()
      .prepare(`SELECT e.run_id AS runId,e.revision,e.plan_id AS planId,e.plan_revision AS planRevision,
      e.type,e.state,e.completed_count AS completedCount,e.error_count AS errorCount,e.wallet_address AS walletAddress,e.created_at AS createdAt,
      json_extract(p.document,'$.name') AS name,json_extract(r.document,'$.chain') AS chain,json_array_length(r.document,'$.wallets') AS walletCount
      FROM warmup_history_run_events e JOIN warmup_history_runs r ON r.owner_id=e.owner_id AND r.id=e.run_id
      JOIN wallet_warmup_plans p ON p.owner_id=e.owner_id AND p.id=e.plan_id
      WHERE e.owner_id=? ${cursor ? 'AND (e.created_at<? OR (e.created_at=? AND (e.run_id<? OR (e.run_id=? AND e.revision<?))))' : ''}
      ORDER BY e.created_at DESC,e.run_id DESC,e.revision DESC LIMIT 51`)
      .bind(
        user.userId,
        ...(cursor
          ? [cursor[0], cursor[0], cursor[1], cursor[1], cursor[2]]
          : []),
      )
      .all<Omit<WarmupRunActivityEvent, 'id'>>();
    const events = rows.results
      .slice(0, 50)
      .map((event) => ({ ...event, id: `${event.runId}:${event.revision}` }));
    const last = events.at(-1);
    return json({
      events,
      nextCursor:
        rows.results.length > 50 && last
          ? JSON.stringify([last.createdAt, last.runId, last.revision])
          : null,
      executionAllowed: false,
    });
  } catch {
    return json({ error: 'Warmup run activity temporarily unavailable.' }, 503);
  }
}
