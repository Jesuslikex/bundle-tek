import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  projectIdValid,
  validateProjectDocument,
} from '@/lib/workspace-project';
import { shareExpiresAt } from '@/lib/project-share-expiry';
import {
  readProjectShareScope,
  shareAssignmentCandidates,
  type ProjectShareScope,
} from '@/lib/project-share-scope';
import { createScopedSharedProjectSnapshot } from '@/lib/shared-project-review';

// View-only by default. An immutable owner opt-in can separately allow edits to
// three saved text fields. Wallets, publication and signing stay with the owner.
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
  expiresAt: string | null;
  expired: number;
  walletScope: string | null;
  metadataEdit: number;
};
type SharedRow = {
  shareId: string;
  id: string;
  document: string;
  archived: number;
  updatedAt: string;
  expiresAt: string | null;
  walletScope: string | null;
  metadataEdit: number;
};
function ownerScopeSummary(scope: string | null) {
  if (scope === null) return { mode: 'legacy', count: null };
  try {
    const count = readProjectShareScope(JSON.parse(scope)).wallets.length;
    return { mode: count ? 'selected' : 'none', count };
  } catch {
    // Owners must still be able to revoke a corrupt row. This grants no reads.
    return { mode: 'unavailable', count: null };
  }
}

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
          `SELECT id, member_id AS memberId, created_at AS createdAt, accepted_at AS acceptedAt,
           expires_at AS expiresAt, wallet_scope AS walletScope, metadata_edit AS metadataEdit, (expires_at IS NOT NULL AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS expired
           FROM project_shares WHERE owner_id=? AND project_id=? AND revoked_at IS NULL
           ORDER BY created_at DESC LIMIT 10`,
        )
        .bind(user.userId, projectId)
        .all<ShareRow>();
      const source = await db
        .prepare(
          'SELECT document,updated_at AS projectRevision FROM workspace_projects WHERE owner_id=? AND id=?',
        )
        .bind(user.userId, projectId)
        .first<{ document: string; projectRevision: string }>();
      let assignmentSource: {
        projectId: string;
        projectRevision: string;
        candidates: ReturnType<typeof shareAssignmentCandidates>;
      } | null = null;
      try {
        assignmentSource = source
          ? {
              projectId,
              projectRevision: source.projectRevision,
              candidates: shareAssignmentCandidates(
                validateProjectDocument(JSON.parse(source.document)),
              ),
            }
          : null;
      } catch {
        /* Keep owner revocation usable. */
      }
      return json({
        source: assignmentSource,
        shares: result.results.map((s) => ({
          id: s.id,
          accepted: s.memberId !== null,
          createdAt: s.createdAt,
          acceptedAt: s.acceptedAt,
          expiresAt: s.expiresAt,
          expired: Boolean(s.expired),
          walletScope: ownerScopeSummary(s.walletScope),
          permissions: { editMetadata: s.metadataEdit === 1 },
        })),
      });
    }
    const result = await db
      .prepare(
        `SELECT s.id AS shareId, p.id, p.document, p.archived, p.updated_at AS updatedAt, s.expires_at AS expiresAt, s.wallet_scope AS walletScope, s.metadata_edit AS metadataEdit
         FROM project_shares s JOIN workspace_projects p ON p.owner_id=s.owner_id AND p.id=s.project_id
         WHERE s.member_id=? AND s.revoked_at IS NULL
          AND (s.expires_at IS NULL OR s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ORDER BY p.updated_at DESC LIMIT 100`,
      )
      .bind(user.userId)
      .all<SharedRow>();
    return json({
      projects: result.results.map((r) =>
        createScopedSharedProjectSnapshot(
          {
            id: r.id,
            shareId: r.shareId,
            archived: Boolean(r.archived),
            updatedAt: r.updatedAt,
            expiresAt: r.expiresAt,
          },
          validateProjectDocument(JSON.parse(r.document)),
          r.walletScope === null
            ? null
            : readProjectShareScope(JSON.parse(r.walletScope)),
          { editMetadata: r.metadataEdit === 1 },
        ),
      ),
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
    expiresInSeconds?: unknown;
    walletScope?: unknown;
    permissions?: unknown;
  };
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 49152)
      return json({ error: 'Request too large.' }, 413);
    body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return json({ error: 'Invalid request.' }, 400);
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }
  const db = getD1();
  const now = new Date().toISOString();
  try {
    if (body.action === 'invite') {
      if (!projectIdValid(body.projectId))
        return json({ error: 'Invalid project.' }, 400);
      let editMetadata = false;
      if (body.permissions !== undefined) {
        const permission = body.permissions as { editMetadata?: unknown };
        if (
          !permission ||
          typeof permission !== 'object' ||
          Array.isArray(permission) ||
          Object.keys(permission).join(',') !== 'editMetadata' ||
          typeof permission.editMetadata !== 'boolean'
        )
          return json(
            { error: 'Choose an explicit saved-text editing permission.' },
            400,
          );
        editMetadata = permission.editMetadata;
      }
      const source = await db
        .prepare(
          'SELECT document,updated_at AS projectRevision FROM workspace_projects WHERE owner_id=? AND id=?',
        )
        .bind(user.userId, body.projectId)
        .first<{ document: string; projectRevision: string }>();
      if (!source) return json({ error: 'Project not found.' }, 404);
      let walletScope: ProjectShareScope;
      try {
        walletScope = readProjectShareScope(
          body.walletScope === undefined
            ? {
                format: 'project-share-wallet-scope-v1',
                projectRevision: source.projectRevision,
                wallets: [],
              }
            : body.walletScope,
        );
      } catch {
        return json({ error: 'Choose valid saved wallet assignments.' }, 400);
      }
      if (walletScope.projectRevision !== source.projectRevision)
        return json(
          {
            error:
              'Project changed. Reload saved wallet assignments before creating an invite.',
          },
          409,
        );
      const candidates = shareAssignmentCandidates(
        validateProjectDocument(JSON.parse(source.document)),
      );
      if (
        walletScope.wallets.some(
          (w) =>
            !candidates.some(
              (c) =>
                c.chain === w.chain &&
                c.address === w.address &&
                c.revision === w.revision &&
                c.role === w.role,
            ),
        )
      )
        return json(
          {
            error:
              'Project changed. Reload saved wallet assignments before creating an invite.',
          },
          409,
        );
      let expiresAt: string;
      try {
        expiresAt = shareExpiresAt(body.expiresInSeconds, now);
      } catch {
        return json(
          { error: 'Choose a share duration of 1 hour, 24 hours or 7 days.' },
          400,
        );
      }
      const token = newToken();
      const id = crypto.randomUUID();
      try {
        await db
          .prepare(
            'INSERT INTO project_shares(id,owner_id,project_id,token_hash,created_at,expires_at,wallet_scope,metadata_edit) VALUES(?,?,?,?,?,?,?,?)',
          )
          .bind(
            id,
            user.userId,
            body.projectId,
            await hash(token),
            now,
            expiresAt,
            JSON.stringify(walletScope),
            editMetadata ? 1 : 0,
          )
          .run();
      } catch (e) {
        const message = e instanceof Error ? e.message : '';
        if (message.includes('Project not found'))
          return json({ error: 'Project not found.' }, 404);
        if (message.includes('Share limit reached'))
          return json({ error: 'Up to 10 shares per project.' }, 409);
        if (
          message.includes('Share source changed') ||
          message.includes('Share wallet scope invalid')
        )
          return json(
            {
              error:
                'Project changed. Reload saved wallet assignments before creating an invite.',
            },
            409,
          );
        throw e;
      }
      return json(
        { share: { id, token, expiresAt, permissions: { editMetadata } } },
        201,
      );
    }
    if (body.action === 'accept') {
      if (typeof body.token !== 'string' || !TOKEN.test(body.token))
        return json({ error: 'Invalid invite link.' }, 400);
      const row = await db
        .prepare(
          `SELECT id, owner_id AS ownerId, project_id AS projectId, member_id AS memberId FROM project_shares
           WHERE token_hash=? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        )
        .bind(await hash(body.token))
        .first<{
          id: string;
          ownerId: string;
          projectId: string;
          memberId: string | null;
        }>();
      if (!row)
        return json({ error: 'Invite not found, expired or revoked.' }, 404);
      if (row.ownerId === user.userId)
        return json({ error: 'This is your own project.' }, 409);
      if (row.memberId === user.userId) return json({ shareId: row.id });
      if (row.memberId !== null)
        return json({ error: 'This invite was already used.' }, 409);
      const previous = await db
        .prepare(`SELECT (expires_at IS NOT NULL AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS expired
        FROM project_shares WHERE owner_id=? AND project_id=? AND member_id=? AND revoked_at IS NULL LIMIT 1`)
        .bind(row.ownerId, row.projectId, user.userId)
        .first<{ expired: number }>();
      if (previous)
        return json(
          {
            error: previous.expired
              ? 'Ask the owner to revoke your expired share before accepting a new invite.'
              : 'You already have a share for this project. Refresh shared projects.',
          },
          409,
        );
      const result = await db
        .prepare(
          `UPDATE project_shares SET member_id=?, accepted_at=? WHERE id=? AND member_id IS NULL AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
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
