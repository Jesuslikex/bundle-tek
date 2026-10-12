import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  isWarmupSigningEvent,
  type WarmupSigningEvent,
} from '@/lib/warmup-signing-events';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to view warmup execution activity.' }, 401);
  const query = new URL(request.url).searchParams,
    cursor = query.get('cursor'),
    planId = query.get('planId');
  if (
    (cursor !== null && !/^[a-f0-9]{32}$/.test(cursor)) ||
    (planId !== null && !/^[a-zA-Z0-9-]{1,64}$/.test(planId))
  )
    return json({ error: 'Invalid execution activity context.' }, 400);
  try {
    const db = getD1();
    if (
      planId &&
      !(await db
        .prepare('SELECT id FROM wallet_warmup_plans WHERE owner_id=? AND id=?')
        .bind(user.userId, planId)
        .first())
    )
      return json({ error: 'Warmup plan not found.' }, 404);
    const anchor = cursor
      ? await db
          .prepare(
            'SELECT id,sequence,created_at AS createdAt FROM warmup_signing_events WHERE owner_id=? AND id=? AND (? IS NULL OR plan_id=?)',
          )
          .bind(user.userId, cursor, planId, planId)
          .first<{ id: string; sequence: number; createdAt: string }>()
      : null;
    if (cursor && !anchor)
      return json({ error: 'Execution activity cursor unavailable.' }, 400);
    const result = await db
      .prepare(
        `SELECT id,sequence,intent_id AS intentId,preparation_id AS preparationId,plan_id AS planId,plan_revision AS planRevision,cycle,wallet_address AS wallet,type,state,signature,failure_receipt AS failureReceipt,document,created_at AS createdAt FROM warmup_signing_events WHERE owner_id=? AND (? IS NULL OR plan_id=?) AND (? IS NULL OR created_at<? OR (created_at=? AND sequence<?)) ORDER BY created_at DESC,sequence DESC LIMIT 51`,
      )
      .bind(
        user.userId,
        planId,
        planId,
        anchor?.createdAt ?? null,
        anchor?.createdAt ?? '',
        anchor?.createdAt ?? '',
        anchor?.sequence ?? 0,
      )
      .all<
        Omit<WarmupSigningEvent, 'document' | 'failureReceipt'> & {
          document: string;
          failureReceipt: string | null;
        }
      >();
    const events = result.results.slice(0, 50).map((row) => {
      const event = {
        ...row,
        document: JSON.parse(row.document),
        failureReceipt: row.failureReceipt
          ? JSON.parse(row.failureReceipt)
          : null,
      } as WarmupSigningEvent;
      if (!isWarmupSigningEvent(event)) throw new Error();
      return event;
    });
    return json({
      events,
      nextCursor: result.results.length > 50 ? events.at(-1)!.id : null,
    });
  } catch {
    return json({ error: 'Warmup execution activity unavailable.' }, 503);
  }
}
