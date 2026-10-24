import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  projectIdValid,
  validateProjectDocument,
} from '@/lib/workspace-project';
import {
  OwnedProjectReadError,
  validateOwnedProjectResponse,
} from '@/lib/owned-project-read';
import { PANEL_JSON_RESPONSE_BYTES } from '@/lib/read-bounded-panel-json';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
type Row = {
  id: string;
  document: string;
  archived: number;
  updatedAt: string;
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getChatGPTUser();
    if (!user)
      return json({ error: new OwnedProjectReadError(401).message }, 401);
    request.signal.throwIfAborted();
    const { id } = await params;
    if (new URL(request.url).searchParams.size || !projectIdValid(id))
      return json({ error: new OwnedProjectReadError(400).message }, 400);
    request.signal.throwIfAborted();
    const row = await getD1()
      .prepare(
        'SELECT id,document,archived,updated_at AS updatedAt FROM workspace_projects WHERE owner_id=? AND id=?',
      )
      .bind(user.userId, id)
      .first<Row>();
    request.signal.throwIfAborted();
    if (!row)
      return json({ error: new OwnedProjectReadError(404).message }, 404);
    if (
      typeof row.document !== 'string' ||
      new TextEncoder().encode(row.document).length >
        PANEL_JSON_RESPONSE_BYTES ||
      (row.archived !== 0 && row.archived !== 1)
    )
      throw Error('Invalid stored project.');
    const project = validateOwnedProjectResponse(
      {
        project: {
          ...validateProjectDocument(JSON.parse(row.document)),
          id: row.id,
          archived: row.archived === 1,
          updatedAt: row.updatedAt,
        },
      },
      id,
    );
    request.signal.throwIfAborted();
    return json({ project });
  } catch {
    return json({ error: new OwnedProjectReadError(503).message }, 503);
  }
}
