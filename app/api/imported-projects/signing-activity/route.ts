import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { UUID } from '@/lib/wallet-operation';
import {
  isImportedSigningEvent,
  type ImportedSigningEvent,
} from '@/lib/imported-signing-events';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to view imported swap activity.' }, 401);
  const params = new URL(request.url).searchParams,
    cursor = params.get('cursor'),
    projectId = params.get('projectId');
  if (
    (cursor !== null && !/^[a-f0-9]{32}$/.test(cursor)) ||
    (projectId !== null && !UUID.test(projectId))
  )
    return json({ error: 'Invalid swap activity context.' }, 400);
  try {
    const db = getD1();
    if (
      projectId &&
      !(await db
        .prepare(
          'SELECT id FROM imported_token_projects WHERE owner_id=? AND id=?',
        )
        .bind(user.userId, projectId)
        .first())
    )
      return json({ error: 'Imported project unavailable.' }, 404);
    const anchor = cursor
      ? await db
          .prepare(
            'SELECT id,sequence,created_at AS createdAt FROM imported_swap_signing_events WHERE owner_id=? AND id=? AND (? IS NULL OR project_id=?)',
          )
          .bind(user.userId, cursor, projectId, projectId)
          .first<{ id: string; sequence: number; createdAt: string }>()
      : null;
    if (cursor && !anchor)
      return json({ error: 'Swap activity cursor unavailable.' }, 400);
    const result = await db
      .prepare(
        'SELECT id,sequence,intent_id AS intentId,preparation_id AS preparationId,project_id AS projectId,project_revision AS projectRevision,wallet_revision AS walletRevision,wallet_address AS wallet,type,state,signature,failure_receipt AS failureReceipt,document,created_at AS createdAt FROM imported_swap_signing_events WHERE owner_id=? AND (? IS NULL OR project_id=?) AND (? IS NULL OR created_at<? OR (created_at=? AND sequence<?)) ORDER BY created_at DESC,sequence DESC LIMIT 51',
      )
      .bind(
        user.userId,
        projectId,
        projectId,
        anchor?.createdAt ?? null,
        anchor?.createdAt ?? '',
        anchor?.createdAt ?? '',
        anchor?.sequence ?? 0,
      )
      .all<
        Omit<ImportedSigningEvent, 'document' | 'failureReceipt'> & {
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
      };
      if (!isImportedSigningEvent(event)) throw new Error();
      return event;
    });
    return json({
      events,
      nextCursor: result.results.length > 50 ? events.at(-1)!.id : null,
    });
  } catch {
    return json({ error: 'Imported swap activity unavailable.' }, 503);
  }
}
