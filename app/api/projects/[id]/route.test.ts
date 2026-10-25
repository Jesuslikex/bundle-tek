import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '@/db/turso';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  type WorkspaceProject,
} from '@/lib/workspace-project';
import { PANEL_JSON_RESPONSE_BYTES } from '@/lib/read-bounded-panel-json';

const mocks = vi.hoisted(() => ({ user: vi.fn(), database: vi.fn() }));
vi.mock('@/app/chatgpt-auth', () => ({ getChatGPTUser: mocks.user }));
vi.mock('@/db', () => ({ getD1: mocks.database }));
import { GET } from './route';
let client: Client, db: D1Database;
const document = () => ({
  plan: { ...DEFAULT_LAUNCH_PLAN },
  identity: { ...EMPTY_IDENTITY },
  options: { ...DEFAULT_VENUE_OPTIONS },
});
beforeEach(async () => {
  vi.resetAllMocks();
  client = createClient({ url: 'file::memory:' });
  db = createTursoDatabase(client);
  // Real committed table/index DDL. Financial mutation triggers are not under test.
  for (const sql of readFileSync(
    new URL(
      '../../../../drizzle/0005_special_marten_broadcloak.sql',
      import.meta.url,
    ),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await db.prepare(sql).run();
  mocks.user.mockResolvedValue({ userId: 'alice' });
  mocks.database.mockReturnValue(db);
});
afterEach(() => client.close());
const add = (
  id = 'old-project',
  owner = 'alice',
  archived = 0,
  doc = JSON.stringify(document()),
  updated = '2026-10-01T00:00:00.000Z',
) =>
  db
    .prepare(
      'INSERT INTO workspace_projects(id,owner_id,document,archived,updated_at) VALUES(?,?,?,?,?)',
    )
    .bind(id, owner, doc, archived, updated)
    .run();
const get = (id = 'old-project', query = '', signal?: AbortSignal) =>
  GET(new Request(`http://localhost/api/projects/${id}${query}`, { signal }), {
    params: Promise.resolve({ id }),
  });
async function error(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = (await response.json()) as { error: string };
  expect(Object.keys(body)).toEqual(['error']);
  expect(body.error).not.toMatch(/SECRET|sqlite|SELECT|Unexpected|JSON/);
  return body;
}
it('reads only the requested owner project and omits unrequested columns', async () => {
  await add();
  await add(
    'old-project',
    'bob',
    0,
    JSON.stringify({ ...document(), secret: 'SECRET_OTHER_OWNER' }),
  );
  const prepare = vi.spyOn(db, 'prepare');
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = (await response.json()) as { project: WorkspaceProject };
  expect(Object.keys(body)).toEqual(['project']);
  expect(Object.keys(body.project).sort()).toEqual([
    'archived',
    'id',
    'identity',
    'options',
    'plan',
    'updatedAt',
  ]);
  expect(body.project).toMatchObject({
    id: 'old-project',
    archived: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  });
  expect(JSON.stringify(body)).not.toMatch(/owner_id|document|SECRET/);
  expect(prepare).toHaveBeenCalledExactlyOnceWith(
    'SELECT id,document,archived,updated_at AS updatedAt FROM workspace_projects WHERE owner_id=? AND id=?',
  );
});
it('includes archived rows without restoring or writing them', async () => {
  await add('old-project', 'alice', 1);
  expect(
    ((await (await get()).json()) as { project: WorkspaceProject }).project
      .archived,
  ).toBe(true);
  expect(
    (
      await db
        .prepare('SELECT archived FROM workspace_projects')
        .first<{ archived: number }>()
    )?.archived,
  ).toBe(1);
});
it('uses the authenticated user ID on each request, never a fixed owner', async () => {
  await add();
  const bob = document();
  bob.plan.tokenName = 'Bob saved project';
  await add('old-project', 'bob', 0, JSON.stringify(bob));
  mocks.user.mockResolvedValue({ userId: 'bob' });
  const response = await get();
  expect(response.status).toBe(200);
  expect(
    ((await response.json()) as { project: WorkspaceProject }).project.plan
      .tokenName,
  ).toBe('Bob saved project');
});
it('finds a saved project older than the newest100-list cap', async () => {
  await add();
  for (let n = 0; n < 101; n++)
    await add(
      `new-${n}`,
      'alice',
      0,
      JSON.stringify(document()),
      '2026-10-24T00:00:00.000Z',
    );
  const listed = await db
    .prepare(
      'SELECT id FROM workspace_projects WHERE owner_id=? ORDER BY updated_at DESC LIMIT 100',
    )
    .bind('alice')
    .all<{ id: string }>();
  expect(listed.results.some((row) => row.id === 'old-project')).toBe(false);
  expect(
    ((await (await get()).json()) as { project: WorkspaceProject }).project.id,
  ).toBe('old-project');
});
it('returns identical missing and other-owner404 responses', async () => {
  await add('bob-only', 'bob');
  expect(await error(await get('bob-only'), 404)).toEqual(
    await error(await get('missing'), 404),
  );
});
it.each(['?owner=bob', '?archived=0', '?id=other', '?cursor=x', '?id=x&id=y'])(
  'rejects unsupported filters before DB: %s',
  async (query) => {
    await error(await get('old-project', query), 400);
    expect(mocks.database).not.toHaveBeenCalled();
  },
);
it.each(['', '../bad', 'a_b', 'a'.repeat(65), 'a%20b'])(
  'rejects malformed route identity before DB: %s',
  async (id) => {
    await error(await get(id), 400);
    expect(mocks.database).not.toHaveBeenCalled();
  },
);
it('authenticates before validating filters or acquiring a database', async () => {
  mocks.user.mockResolvedValue(null);
  await error(await get('../bad', '?owner=bob'), 401);
  expect(mocks.database).not.toHaveBeenCalled();
});
it('sanitizes authentication exceptions', async () => {
  mocks.user.mockRejectedValue(Error('SECRET_AUTH'));
  await error(await get(), 503);
  expect(mocks.database).not.toHaveBeenCalled();
});
it.each([
  ['SECRET_BAD_JSON', 0, '2026-10-01T00:00:00.000Z'],
  [JSON.stringify(document()), 2, '2026-10-01T00:00:00.000Z'],
  [JSON.stringify(document()), 0, '2026-02-30T00:00:00.000Z'],
  [
    JSON.stringify({
      ...document(),
      options: { totalSupply: 'SECRET_BAD_SUPPLY' },
    }),
    0,
    '2026-10-01T00:00:00.000Z',
  ],
  [' '.repeat(PANEL_JSON_RESPONSE_BYTES + 1), 0, '2026-10-01T00:00:00.000Z'],
] as const)(
  'refuses malformed stored data without leaking it %#',
  async (doc, archived, updated) => {
    await add('old-project', 'alice', archived, doc, updated);
    await error(await get(), 503);
  },
);
it('drops nested extras using the existing canonical parser', async () => {
  await add(
    'old-project',
    'alice',
    0,
    JSON.stringify({
      ...document(),
      owner_id: 'SECRET',
      options: { ...DEFAULT_VENUE_OPTIONS, signingAllowed: true },
    }),
  );
  const response = await get();
  expect(response.status).toBe(200);
  expect(JSON.stringify(await response.json())).not.toMatch(
    /SECRET|signingAllowed/,
  );
});
it('fails closed on missing table', async () => {
  await db.prepare('DROP TABLE workspace_projects').run();
  await error(await get(), 503);
});
it('cancellation before query does not acquire a database', async () => {
  const c = new AbortController();
  c.abort();
  await error(await get('old-project', '', c.signal), 503);
  expect(mocks.database).not.toHaveBeenCalled();
});
it('cancellation after the owned query discards the result', async () => {
  const c = new AbortController();
  await add();
  const actual = await db
    .prepare(
      'SELECT id,document,archived,updated_at AS updatedAt FROM workspace_projects WHERE owner_id=? AND id=?',
    )
    .bind('alice', 'old-project')
    .first();
  const first = vi.fn(async () => {
    c.abort();
    return actual;
  });
  mocks.database.mockReturnValue({
    prepare: () => ({ bind: () => ({ first }) }),
  });
  await error(await get('old-project', '', c.signal), 503);
  expect(first).toHaveBeenCalledOnce();
});
it('refuses a mismatched database row identity', async () => {
  mocks.database.mockReturnValue({
    prepare: () => ({
      bind: () => ({
        first: async () => ({
          id: 'other',
          document: JSON.stringify(document()),
          archived: 0,
          updatedAt: '2026-10-01T00:00:00.000Z',
        }),
      }),
    }),
  });
  await error(await get(), 503);
});
