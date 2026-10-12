import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { UUID } from '@/lib/wallet-operation';
import type { WarmupHistoryRunEvent } from '@/lib/warmup-history-run-events';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view the run timeline.' }, 401);
  const query = new URL(request.url).searchParams,
    id = query.get('id'),
    raw = query.get('before');
  const before = raw === null ? 1000000001 : Number(raw);
  if (
    !id ||
    !UUID.test(id) ||
    (raw !== null &&
      (!/^[1-9]\d{0,9}$/.test(raw) ||
        !Number.isSafeInteger(before) ||
        before > 1e9))
  )
    return json({ error: 'Choose a run and valid timeline cursor.' }, 400);
  try {
    const db = getD1();
    if (
      !(await db
        .prepare('SELECT id FROM warmup_history_runs WHERE owner_id=? AND id=?')
        .bind(user.userId, id)
        .first())
    )
      return json({ error: 'Run unavailable.' }, 404);
    const rows = await db
      .prepare(
        `SELECT run_id AS runId,revision,plan_id AS planId,plan_revision AS planRevision,type,state,completed_count AS completedCount,error_count AS errorCount,wallet_address AS walletAddress,result_document AS resultDocument,created_at AS createdAt FROM warmup_history_run_events WHERE owner_id=? AND run_id=? AND revision<? ORDER BY revision DESC LIMIT 21`,
      )
      .bind(user.userId, id, before)
      .all<
        Omit<WarmupHistoryRunEvent, 'result'> & {
          resultDocument: string | null;
        }
      >();
    const values = rows.results.slice(0, 20);
    return json({
      id,
      events: values.map(({ resultDocument, ...event }) => ({
        ...event,
        result: resultDocument === null ? null : JSON.parse(resultDocument),
      })),
      nextBefore: rows.results.length > 20 ? values.at(-1)!.revision : null,
      executionAllowed: false,
    });
  } catch {
    return json({ error: 'Run timeline unavailable.' }, 503);
  }
}
