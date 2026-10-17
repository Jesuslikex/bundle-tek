import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  projectIdValid,
  validateProjectDocument,
} from '@/lib/workspace-project';

// Read-only project sharing. A collaborator can open the owner's saved launch
// project; wallets and signing stay with the owner, whose keys never leave
// their browser.
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SHARE_ID = /^[0-9a-f-]{36}$/;

async function hash(token: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

type ShareRow = {
  id: string;
  memberId: string | null;
  createdAt: string;
  acceptedAt: string | null;
};
type SharedRow = {
  shareId: string;
  id: string;
  document: string;
  archived: number;
  updatedAt: string;
};

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to see shared projects.' }, 401);
  const projectId = new URL(request.url).searchParams.get('projectId');
  try {
    const db = getD1();
    if (projectId !== null) {
      if (!projectIdValid(projectId))
        return json({ error: 'Invalid project.' }, 400);
      const result = await db
        .prepare(
          `SELECT id, member_id AS memberId, created_at AS createdAt, accepted_at AS acceptedAt
           FROM project_shares WHERE owner_id=? AND project_id=? AND revoked_at IS NULL
           ORDER BY created_at DESC LIMIT 10`,
        )
        .bind(user.userId, projectId)
        .all<ShareRow>();
      return json({
        shares: result.results.map((s) => ({
          id: s.id,
          accepted: s.memberId !== null,
          createdAt: s.createdAt,
          acceptedAt: s.acceptedAt,
        })),
      });
    }
    const result = await db
      .prepare(
        `SELECT s.id AS shareId, p.id, p.document, p.archived, p.updated_at AS updatedAt
         FROM project_shares s JOIN workspace_projects p ON p.owner_id=s.owner_id AND p.id=s.project_id
         WHERE s.member_id=? AND s.revoked_at IS NULL ORDER BY p.updated_at DESC LIMIT 100`,
      )
      .bind(user.userId)
      .all<SharedRow>();
    return json({
      projects: result.results.map((r) => ({
        ...validateProjectDocument(JSON.parse(r.document)),
        id: r.id,
        shareId: r.shareId,
        archived: Boolean(r.archived),
        updatedAt: r.updatedAt,
        readOnly: true,
      })),
    });
  } catch {
    return json({ error: 'Shared projects temporarily unavailable.' }, 503);
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to share projects.' }, 401);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin)
    return json({ error: 'Cross-origin request rejected.' }, 403);
  let body: {
    action?: unknown;
    projectId?: unknown;
    token?: unknown;
    id?: unknown;
  };
  try {
    const text = await request.text();
    if (text.length > 1024) return json({ error: 'Request too large.' }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }
  const db = getD1();
  const now = new Date().toISOString();
  try {
    if (body.action === 'invite') {
      if (!projectIdValid(body.projectId))
        return json({ error: 'Invalid project.' }, 400);
      const token = newToken();
      const id = crypto.randomUUID();
      try {
        await db
          .prepare(
            'INSERT INTO project_shares(id,owner_id,project_id,token_hash,created_at) VALUES(?,?,?,?,?)',
          )
          .bind(id, user.userId, body.projectId, await hash(token), now)
          .run();
      } catch (e) {
        const message = e instanceof Error ? e.message : '';
        if (message.includes('Project not found'))
          return json({ error: 'Project not found.' }, 404);
        if (message.includes('Share limit reached'))
          return json({ error: 'Up to 10 shares per project.' }, 409);
        throw e;
      }
      return json({ share: { id, token } }, 201);
    }
    if (body.action === 'accept') {
      if (typeof body.token !== 'string' || !TOKEN.test(body.token))
        return json({ error: 'Invalid invite link.' }, 400);
      const row = await db
        .prepare(
          'SELECT id, owner_id AS ownerId, member_id AS memberId FROM project_shares WHERE token_hash=? AND revoked_at IS NULL',
        )
        .bind(await hash(body.token))
        .first<{ id: string; ownerId: string; memberId: string | null }>();
      if (!row) return json({ error: 'Invite not found or revoked.' }, 404);
      if (row.ownerId === user.userId)
        return json({ error: 'This is your own project.' }, 409);
      if (row.memberId === user.userId) return json({ shareId: row.id });
      if (row.memberId !== null)
        return json({ error: 'This invite was already used.' }, 409);
      const result = await db
        .prepare(
          'UPDATE project_shares SET member_id=?, accepted_at=? WHERE id=? AND member_id IS NULL AND revoked_at IS NULL',
        )
        .bind(user.userId, now, row.id)
        .run()
        .catch(() => null);
      if (!result?.meta.changes)
        return json({ error: 'This invite could not be accepted.' }, 409);
      return json({ shareId: row.id });
    }
    if (body.action === 'revoke' || body.action === 'leave') {
      if (typeof body.id !== 'string' || !SHARE_ID.test(body.id))
        return json({ error: 'Invalid share.' }, 400);
      const column = body.action === 'revoke' ? 'owner_id' : 'member_id';
      const result = await db
        .prepare(
          `UPDATE project_shares SET revoked_at=? WHERE id=? AND ${column}=? AND revoked_at IS NULL`,
        )
        .bind(now, body.id, user.userId)
        .run();
      if (!result.meta.changes) return json({ error: 'Share not found.' }, 404);
      return json({ ok: true });
    }
    return json({ error: 'Unknown action.' }, 400);
  } catch {
    return json({ error: 'Sharing temporarily unavailable.' }, 503);
  }
}
