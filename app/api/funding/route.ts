import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { validateFunding } from '@/lib/funding-plan';
import {
  fundingOwnerScope,
  FUNDING_OWNER_SCOPE_HEADER,
} from '@/lib/funding-owner-scope';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200, ownerScope?: string) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(ownerScope ? { [FUNDING_OWNER_SCOPE_HEADER]: ownerScope } : {}),
    },
  });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  const ownerScope = user ? fundingOwnerScope(user.userId) : undefined;
  const reply = (body: unknown, status = 200) => json(body, status, ownerScope);
  if (!user) return reply({ error: 'Sign in to open funding plans.' }, 401);
  const requestedScope = request?.headers.get(FUNDING_OWNER_SCOPE_HEADER);
  if (
    requestedScope !== null &&
    requestedScope !== undefined &&
    requestedScope !== ownerScope
  )
    return reply(
      {
        error:
          'The signed-in account changed. Reload saved funding plans before continuing.',
      },
      403,
    );
  const id = request ? new URL(request.url).searchParams.get('id') : null;
  if (id !== null && !/^[a-zA-Z0-9-]{1,64}$/.test(id))
    return reply({ error: 'Choose a valid saved funding draft.' }, 400);
  try {
    if (id !== null) {
      const row = await getD1()
        .prepare(
          'SELECT id, document, revision, archived, updated_at AS updatedAt FROM funding_plans WHERE owner_id=? AND id=?',
        )
        .bind(user.userId, id)
        .first<{
          id: string;
          document: string;
          revision: number;
          archived: number;
          updatedAt: string;
        }>();
      if (!row) return reply({ error: 'Saved funding draft not found.' }, 404);
      return reply({
        plan: {
          ...row,
          archived: Boolean(row.archived),
          document: JSON.parse(row.document),
        },
      });
    }
    const rows = await getD1()
      .prepare(
        'SELECT id, document, revision, archived, updated_at AS updatedAt FROM funding_plans WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 100',
      )
      .bind(user.userId)
      .all<{
        id: string;
        document: string;
        revision: number;
        archived: number;
        updatedAt: string;
      }>();
    return reply({
      plans: rows.results.map((r) => ({
        ...r,
        archived: Boolean(r.archived),
        document: JSON.parse(r.document),
      })),
    });
  } catch {
    return reply({ error: 'Funding storage temporarily unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  const ownerScope = user ? fundingOwnerScope(user.userId) : undefined;
  const reply = (body: unknown, status = 200) => json(body, status, ownerScope);
  if (!user) return reply({ error: 'Sign in to save funding plans.' }, 401);
  const requestedScope = request.headers.get(FUNDING_OWNER_SCOPE_HEADER);
  if (requestedScope !== null && requestedScope !== ownerScope)
    return reply(
      {
        error:
          'The signed-in account changed. Reload saved funding plans before continuing.',
        ...(/^[a-f0-9]{64}$/.test(requestedScope)
          ? {
              code: 'FUNDING_SCOPE_REJECTED_BEFORE_WRITE',
              rejectedScope: requestedScope,
            }
          : {}),
      },
      403,
    );
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return reply({ error: 'JSON required.' }, 415);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return reply({ error: 'Cross-origin write rejected.' }, 403);
  let writing = false;
  try {
    const text = await request.text();
    if (text.length > 30000)
      return reply({ error: 'Funding plan is too large.' }, 413);
    const b = JSON.parse(text);
    if (typeof b.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(b.id))
      throw new Error('Invalid plan ID.');
    if (
      !Number.isSafeInteger(b.expectedRevision) ||
      b.expectedRevision < 0 ||
      b.expectedRevision > 1000000000
    )
      throw new Error('Invalid plan revision.');
    if (
      !['save', 'archive', 'restore'].includes(b.action) ||
      (b.expectedRevision === 0 && b.action !== 'save')
    )
      throw new Error('Invalid funding action.');
    const doc = b.action === 'save' ? validateFunding(b.document) : null;
    const db = getD1(),
      mutation = crypto.randomUUID(),
      now = new Date().toISOString();
    const update =
      b.expectedRevision === 0
        ? db
            .prepare(`INSERT INTO funding_plans (owner_id,id,document,revision,archived,mutation_id,updated_at)
        SELECT ?,?,?,1,0,?,? WHERE (SELECT COUNT(*) FROM funding_plans WHERE owner_id=?) < 100
        ON CONFLICT(owner_id,id) DO NOTHING`)
            .bind(
              user.userId,
              b.id,
              JSON.stringify(doc),
              mutation,
              now,
              user.userId,
            )
        : b.action === 'save'
          ? db
              .prepare(
                'UPDATE funding_plans SET document=?, revision=revision+1, mutation_id=?, updated_at=? WHERE owner_id=? AND id=? AND revision=? AND archived=0',
              )
              .bind(
                JSON.stringify(doc),
                mutation,
                now,
                user.userId,
                b.id,
                b.expectedRevision,
              )
          : db
              .prepare(
                'UPDATE funding_plans SET archived=?, revision=revision+1, mutation_id=?, updated_at=? WHERE owner_id=? AND id=? AND revision=? AND archived=?',
              )
              .bind(
                b.action === 'archive' ? 1 : 0,
                mutation,
                now,
                user.userId,
                b.id,
                b.expectedRevision,
                b.action === 'archive' ? 0 : 1,
              );
    const type =
      b.action === 'save'
        ? b.expectedRevision === 0
          ? 'funding.created'
          : 'funding.updated'
        : `funding.${b.action === 'archive' ? 'archived' : 'restored'}`;
    writing = true;
    const results = await db.batch([
      update,
      db
        .prepare(`INSERT INTO funding_events (owner_id,plan_id,name,chain,type,revision,created_at)
      SELECT owner_id,id,json_extract(document,'$.name'),json_extract(document,'$.chain'),?,revision,updated_at
      FROM funding_plans WHERE owner_id=? AND id=? AND mutation_id=?`)
        .bind(type, user.userId, b.id, mutation),
    ]);
    if (!results[0].meta.changes)
      return reply(
        {
          error:
            'Plan changed in another tab, is archived, or the 100-plan limit was reached. Reload saved plans.',
        },
        409,
      );
    return reply({ id: b.id, revision: b.expectedRevision + 1 });
  } catch (error) {
    return writing
      ? reply({ error: 'Funding storage temporarily unavailable.' }, 503)
      : reply(
          {
            error:
              error instanceof Error
                ? error.message
                : 'Invalid funding request.',
          },
          400,
        );
  }
}
