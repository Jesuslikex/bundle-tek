import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  projectIdValid,
  validateProjectDocument,
} from '@/lib/workspace-project';

export const dynamic = 'force-dynamic';
type Row = {
  id: string;
  document: string;
  archived: number;
  updatedAt: string;
};
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const parse = (row: Row) => ({
  ...validateProjectDocument(JSON.parse(row.document)),
  id: row.id,
  archived: Boolean(row.archived),
  updatedAt: row.updatedAt,
});

export async function GET() {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to open your saved projects.' }, 401);
  try {
    const result = await getD1()
      .prepare(
        'SELECT id, document, archived, updated_at AS updatedAt FROM workspace_projects WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 100',
      )
      .bind(user.userId)
      .all<Row>();
    return json({ projects: result.results.map(parse) });
  } catch {
    return json({ error: 'Project library temporarily unavailable.' }, 503);
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to save projects.' }, 401);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return json({ error: 'Cross-origin save rejected.' }, 403);
  let storageStarted = false;
  try {
    const text = await request.text();
    if (text.length > 24_000)
      return json({ error: 'Project is too large.' }, 413);
    const body = JSON.parse(text);
    if (!projectIdValid(body.id) || typeof body.archived !== 'boolean')
      return json({ error: 'Invalid project.' }, 400);
    const document = validateProjectDocument(body);
    if (
      body.expectedUpdatedAt !== null &&
      (typeof body.expectedUpdatedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
          body.expectedUpdatedAt,
        ) ||
        !Number.isFinite(Date.parse(body.expectedUpdatedAt)))
    )
      return json({ error: 'Missing or invalid project revision.' }, 400);
    // Strictly advance the revision even when two edits occur in the same millisecond.
    const updatedAt = new Date(
      Math.max(
        Date.now(),
        body.expectedUpdatedAt ? Date.parse(body.expectedUpdatedAt) + 1 : 0,
      ),
    ).toISOString();
    storageStarted = true;
    const db = getD1();
    const result =
      body.expectedUpdatedAt === null
        ? await db
            .prepare(`INSERT OR IGNORE INTO workspace_projects (id, owner_id, document, archived, updated_at)
          SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM workspace_projects WHERE owner_id = ?) < 100`)
            .bind(
              body.id,
              user.userId,
              JSON.stringify(document),
              body.archived ? 1 : 0,
              updatedAt,
              user.userId,
            )
            .run()
        : await db
            .prepare(
              `UPDATE workspace_projects SET document = ?, archived = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND updated_at = ?`,
            )
            .bind(
              JSON.stringify(document),
              body.archived ? 1 : 0,
              updatedAt,
              user.userId,
              body.id,
              body.expectedUpdatedAt,
            )
            .run();
    if (!result.meta.changes)
      return json(
        {
          error:
            'Project changed in another tab or the 100-project limit was reached. Refresh the project list and reopen the latest saved project before editing.',
        },
        409,
      );
    return json({
      project: { ...document, id: body.id, archived: body.archived, updatedAt },
    });
  } catch (error) {
    return storageStarted
      ? json(
          {
            error:
              'Project storage temporarily unavailable. Your draft has not been discarded.',
          },
          503,
        )
      : json(
          {
            error: error instanceof Error ? error.message : 'Invalid project.',
          },
          400,
        );
  }
}
