import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { UUID } from '@/lib/wallet-operation';
import { readSessionEntryOutcomes } from '@/lib/session-entry-outcomes-server';
import { decodeTradeSessionEvent } from '@/lib/imported-trade-session-events';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to view session wallet outcomes.' }, 401);
  const query = new URL(request.url).searchParams;
  const projectId = query.get('projectId'),
    requestedSessionId = query.get('sessionId'),
    eventId = query.get('eventId');
  if (
    query.size !== 2 ||
    !projectId ||
    !UUID.test(projectId) ||
    (requestedSessionId !== null
      ? !UUID.test(requestedSessionId) || eventId !== null
      : !eventId || !/^[a-f0-9]{32}$/.test(eventId)) ||
    [...query.keys()].some(
      (key) => !['projectId', 'sessionId', 'eventId'].includes(key),
    )
  )
    return json({ error: 'Choose an owned saved session.' }, 400);
  try {
    const db = getD1();
    if (
      !(await db
        .prepare(
          'SELECT id FROM imported_token_projects WHERE owner_id=? AND id=?',
        )
        .bind(user.userId, projectId)
        .first())
    )
      return json({ error: 'Owned project unavailable.' }, 404);
    let sessionId = requestedSessionId;
    let source: ReturnType<typeof decodeTradeSessionEvent> | null = null;
    if (eventId !== null) {
      const event = await db
        .prepare(
          'SELECT id,sequence,project_id AS projectId,session_id AS sessionId,type,document,approval,control,created_at AS createdAt FROM imported_trade_session_events WHERE owner_id=? AND project_id=? AND id=?',
        )
        .bind(user.userId, projectId, eventId)
        .first<Record<string, unknown>>();
      if (!event)
        return json({ error: 'Owned session event unavailable.' }, 404);
      source = decodeTradeSessionEvent({
        ...event,
        document: JSON.parse(event.document as string),
        approval:
          event.approval === null ? null : JSON.parse(event.approval as string),
        control:
          event.control === null ? null : JSON.parse(event.control as string),
      });
      if (source.id !== eventId || source.projectId !== projectId)
        throw new Error();
      sessionId = source.sessionId;
    }
    const page = await readSessionEntryOutcomes(
      db,
      user.userId,
      projectId,
      sessionId!,
    );
    if (page && source) {
      if (
        page.session.createdAt !== source.document.createdAt ||
        JSON.stringify(page.session.terms) !==
          JSON.stringify(source.document.terms)
      )
        throw new Error();
      page.sourceEventId = source.id;
    }
    return page
      ? json(page)
      : json({ error: 'Owned session unavailable.' }, 404);
  } catch {
    return json(
      { error: 'Retained session wallet outcomes unavailable.' },
      503,
    );
  }
}
