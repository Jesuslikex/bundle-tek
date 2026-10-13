import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { UUID } from '@/lib/wallet-operation';
import {
  operationCategory,
  decodeHistoryCursor,
} from '@/lib/token-operation-history';
import { readTokenOperations } from '@/lib/token-operation-history-server';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to view token operation history.' }, 401);
  const q = new URL(request.url).searchParams,
    projectId = q.get('projectId');
  if (!projectId || !UUID.test(projectId))
    return json({ error: 'Choose a valid token project.' }, 400);
  let category, cursor;
  try {
    category = operationCategory(q.get('category'));
    cursor = decodeHistoryCursor(q.get('cursor'), projectId, category);
  } catch {
    return json({ error: 'Invalid operation history context.' }, 400);
  }
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
      return json({ error: 'Token project unavailable.' }, 404);
    const page = await readTokenOperations(
      db,
      user.userId,
      projectId,
      category,
      cursor,
    );
    return page
      ? json(page)
      : json({ error: 'Owned operation cursor unavailable.' }, 400);
  } catch {
    return json({ error: 'Token operation history unavailable.' }, 503);
  }
}
