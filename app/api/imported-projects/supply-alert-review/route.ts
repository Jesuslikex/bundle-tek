import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
export const dynamic = 'force-dynamic';
const json = (v: unknown, status = 200) =>
  Response.json(v, { status, headers: { 'cache-control': 'no-store' } });
function context(input: Record<string, unknown>) {
  if (
    typeof input.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(input.id) ||
    !Number.isSafeInteger(input.revision) ||
    Number(input.revision) < 1 ||
    typeof input.scope !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.scope)
  )
    throw new Error('Invalid review context.');
  return { id: input.id, revision: Number(input.revision), scope: input.scope };
}
async function handle(request: Request, write: boolean) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to review wallet alerts.' }, 401);
  let c,
    sequence = 0;
  try {
    let input: Record<string, unknown>;
    if (write) {
      if (
        request.headers.get('origin') &&
        request.headers.get('origin') !== new URL(request.url).origin
      )
        return json({ error: 'Cross-origin request rejected.' }, 403);
      if (
        !request.headers
          .get('content-type')
          ?.toLowerCase()
          .startsWith('application/json')
      )
        return json({ error: 'JSON required.' }, 415);
      const text = await request.text();
      if (text.length > 1024)
        return json({ error: 'Review request too large.' }, 413);
      input = JSON.parse(text);
      if (
        Object.keys(input).some(
          (k) => !['id', 'revision', 'scope', 'sequence'].includes(k),
        ) ||
        !Number.isSafeInteger(input.sequence) ||
        Number(input.sequence) < 0
      )
        throw new Error();
      sequence = Number(input.sequence);
    } else {
      const p = new URL(request.url).searchParams;
      if (
        [...p.keys()].some(
          (k) =>
            !['id', 'revision', 'scope'].includes(k) ||
            p.getAll(k).length !== 1,
        )
      )
        throw new Error();
      input = {
        id: p.get('id'),
        revision: Number(p.get('revision')),
        scope: p.get('scope'),
      };
    }
    c = context(input);
  } catch {
    return json({ error: 'Choose a saved watchlist and observation.' }, 400);
  }
  try {
    const db = getD1();
    const project = await db
      .prepare(
        'SELECT revision FROM imported_token_projects WHERE owner_id=? AND id=?',
      )
      .bind(user.userId, c.id)
      .first<{ revision: number }>();
    if (!project) return json({ error: 'Project not found.' }, 404);
    if (project.revision !== c.revision)
      return json({ error: 'Project changed. Reload projects.' }, 409);
    if (
      !(await db
        .prepare(
          'SELECT id FROM imported_supply_scopes WHERE owner_id=? AND project_id=? AND id=?',
        )
        .bind(user.userId, c.id, c.scope)
        .first())
    )
      return json({ error: 'Watchlist not found.' }, 404);
    if (write) {
      if (
        sequence &&
        !(await db
          .prepare(
            'SELECT sequence FROM imported_supply_observations WHERE owner_id=? AND project_id=? AND scope_id=? AND sequence=?',
          )
          .bind(user.userId, c.id, c.scope, sequence)
          .first())
      )
        return json({ error: 'Observation differs from this watchlist.' }, 400);
      const result = await db
        .prepare(
          'INSERT INTO supply_alert_reviews(owner_id,project_id,scope_id,reviewed_through,updated_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=?) AND EXISTS(SELECT 1 FROM imported_supply_scopes WHERE owner_id=? AND project_id=? AND id=?) AND (?=0 OR EXISTS(SELECT 1 FROM imported_supply_observations WHERE owner_id=? AND project_id=? AND scope_id=? AND sequence=?)) ON CONFLICT(owner_id,project_id,scope_id) DO UPDATE SET reviewed_through=CASE WHEN excluded.reviewed_through=0 THEN 0 ELSE MAX(supply_alert_reviews.reviewed_through,excluded.reviewed_through) END,updated_at=excluded.updated_at',
        )
        .bind(
          user.userId,
          c.id,
          c.scope,
          sequence,
          new Date().toISOString(),
          user.userId,
          c.id,
          c.revision,
          user.userId,
          c.id,
          c.scope,
          sequence,
          user.userId,
          c.id,
          c.scope,
          sequence,
        )
        .run();
      if (!result.meta.changes)
        return json(
          { error: 'Project or observation changed before review was saved.' },
          409,
        );
    }
    const saved = await db
      .prepare(
        'SELECT reviewed_through,updated_at FROM supply_alert_reviews WHERE owner_id=? AND project_id=? AND scope_id=?',
      )
      .bind(user.userId, c.id, c.scope)
      .first<{ reviewed_through: number; updated_at: string }>();
    return json({
      ...c,
      reviewedThrough: saved?.reviewed_through ?? 0,
      updatedAt: saved?.updated_at ?? null,
    });
  } catch {
    return json({ error: 'Alert review storage unavailable.' }, 503);
  }
}
export const GET = (request: Request) => handle(request, false);
export const POST = (request: Request) => handle(request, true);
