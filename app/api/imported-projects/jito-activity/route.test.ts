import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { jitoBundleFixture } from '../../../../test/jito-bundle-fixture';
import { jitoDatabase } from '../../../../test/jito-sqlite';
import { readFileSync } from 'node:fs';
import type { JitoBundleEvent } from '@/lib/jito-bundle-events';
const context = vi.hoisted(() => ({
  user: { userId: 'owner' } as { userId: string } | null,
  db: null as D1Database | null,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => context.user,
}));
vi.mock('@/db', () => ({ getD1: () => context.db }));
import { GET, POST } from './route';
type Page = { events: JitoBundleEvent[]; nextCursor: string | null };
let fixture: Awaited<ReturnType<typeof jitoBundleFixture>>;
let database: ReturnType<typeof jitoDatabase>;
const request = (cursor?: string, bundleId?: string) => {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (bundleId) params.set('bundleId', bundleId);
  return new Request(
    'http://localhost/api/imported-projects/jito-activity?' + params,
  );
};
beforeEach(async () => {
  context.user = { userId: 'owner' };
  fixture = await jitoBundleFixture();
  database = jitoDatabase(fixture.manifest);
  database.attach();
  context.db = database.db;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Provider reads forbidden in account activity.');
    }),
  );
});
afterEach(() => {
  database.sqlite.close();
  vi.unstubAllGlobals();
});
it('requires authentication and owner-scopes records, cursors and bundle filters', async () => {
  const own = (await (await GET(request())).json()) as Page;
  context.user = null;
  expect((await GET(request())).status).toBe(401);
  context.user = { userId: 'other' };
  expect(await (await GET(request())).json()).toEqual({
    events: [],
    nextCursor: null,
    baselinePending: false,
  });
  expect((await GET(request(own.events[0].id))).status).toBe(400);
  expect((await GET(request(undefined, fixture.manifest.id))).status).toBe(404);
  expect((await GET(request('not-a-cursor'))).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
it('returns captured public progress without transaction bytes or signatures for archived projects', async () => {
  database.sqlite
    .prepare('UPDATE imported_token_projects SET archived=1')
    .run();
  const response = await GET(request(undefined, fixture.manifest.id));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const data = (await response.json()) as Page;
  expect(data.events[0]).toMatchObject({
    type: 'bundle.reviewed',
    document: {
      id: fixture.manifest.id,
      state: 'reviewed',
      signedCount: 0,
      packetCount: 2,
    },
  });
  expect(JSON.stringify(data)).not.toContain('transaction');
  expect(JSON.stringify(data)).not.toContain(
    fixture.manifest.swaps[0].transaction,
  );
  expect(data.events[0].document).not.toHaveProperty('signatures');
  expect(fetch).not.toHaveBeenCalled();
});
it('paginates tied timestamps by immutable sequence while later bundle transitions occur', async () => {
  const row = database.sqlite
    .prepare('SELECT * FROM jito_bundle_events')
    .get()!;
  for (let i = 0; i < 50; i++)
    database.sqlite
      .prepare(
        'INSERT INTO jito_bundle_events(id,owner_id,bundle_id,project_id,session_id,type,packet,document,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        crypto.randomUUID().replaceAll('-', ''),
        'owner',
        row.bundle_id,
        row.project_id,
        row.session_id,
        row.type,
        null,
        row.document,
        row.created_at,
      );
  const first = (await (await GET(request())).json()) as Page;
  expect(first.events).toHaveLength(50);
  expect(first.nextCursor).toBeTruthy();
  database.sqlite
    .prepare(
      "UPDATE jito_bundles SET state='cancelled',updated_at=? WHERE id=?",
    )
    .run(new Date().toISOString(), fixture.manifest.id);
  const second = (await (await GET(request(first.nextCursor!))).json()) as Page;
  expect(second.events).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set([...first.events, ...second.events].map((r) => r.id)).size,
  ).toBe(51);
  expect(first.events.every((r) => r.document.state === 'reviewed')).toBe(true);
  const refreshed = (await (await GET(request())).json()) as Page;
  expect(refreshed.events[0].type).toBe('bundle.cancelled');
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects a cursor from another bundle in the same account', async () => {
  const own = (await (await GET(request())).json()) as Page;
  const otherId = crypto.randomUUID();
  // Insert a reviewed manifest with valid row bindings; no packet or signing action is required for cursor scope checks.
  const otherManifest = { ...fixture.manifest, id: otherId };
  database.sqlite
    .prepare("INSERT INTO jito_bundles VALUES(?,?,?,?,?,'reviewed',NULL,?,?)")
    .run(
      'owner',
      otherId,
      fixture.manifest.projectId,
      fixture.manifest.sessionId,
      JSON.stringify(otherManifest),
      fixture.manifest.createdAt,
      fixture.manifest.createdAt,
    );
  expect((await GET(request(own.events[0].id, otherId))).status).toBe(400);
});
it('hides internal storage errors', async () => {
  context.db = {
    prepare() {
      throw new Error('Private storage diagnostic');
    },
  } as unknown as D1Database;
  const response = await GET(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: 'Jito bundle activity unavailable.',
  });
});
it('requires an explicit account action for bounded, idempotent baseline recording outside migration', async () => {
  database.sqlite.close();
  database = jitoDatabase(fixture.manifest, false);
  database.attach();
  context.db = database.db;
  database.sqlite.exec(readFileSync('drizzle/0069_amusing_viper.sql', 'utf8'));
  const requestPost = (body: unknown, headers: Record<string, string> = {}) =>
    new Request('http://localhost/api/imported-projects/jito-activity', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const action = { action: 'record-baselines', approved: true };
  context.user = null;
  expect((await POST(requestPost(action))).status).toBe(401);
  context.user = { userId: 'owner' };
  expect(
    (await POST(requestPost(action, { origin: 'https://other.test' }))).status,
  ).toBe(403);
  expect(
    (await POST(requestPost(action, { 'content-type': 'text/plain' }))).status,
  ).toBe(415);
  expect((await POST(requestPost({ action: 'record-baselines' }))).status).toBe(
    400,
  );
  expect(
    (await POST(requestPost({ ...action, padding: 'x'.repeat(512) }))).status,
  ).toBe(413);
  const before = (await (await GET(request())).json()) as Page & {
    baselinePending: boolean;
  };
  expect(before.events).toHaveLength(0);
  expect(before.baselinePending).toBe(true);
  context.user = { userId: 'other' };
  expect(await (await POST(requestPost(action))).json()).toEqual({
    created: 0,
    baselinePending: false,
  });
  context.user = { userId: 'owner' };
  expect(await (await POST(requestPost(action))).json()).toEqual({
    created: 1,
    baselinePending: false,
  });
  expect(await (await POST(requestPost(action))).json()).toEqual({
    created: 0,
    baselinePending: false,
  });
  const after = (await (await GET(request())).json()) as Page;
  expect(after.events[0].type).toBe('bundle.baseline');
  expect(fetch).not.toHaveBeenCalled();
});
