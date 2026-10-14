import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import type { releaseLaunchMetadata } from '@/lib/launch-metadata-release';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  validateProjectDocument,
} from '@/lib/workspace-project';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as null | { userId: string },
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { POST } from './route';
import { GET } from './[id]/route';
import { GET as imageGET } from './[id]/image/route';
import { GET as privateImageGET } from '../../artwork/[id]/route';
let mf: Miniflare;
const origin = 'https://bundle.test';
const updatedAt = '2026-10-14T00:00:00.000Z';
const png = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2QAAAAASUVORK5CYII=',
    'base64',
  ),
);
let artworkId: string;
let sequence = 0;
let description: string;
const releaseJSON = async (response: Response) =>
  (await response.json()) as Awaited<ReturnType<typeof releaseLaunchMetadata>>;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (
  body: unknown = { projectId: 'p', updatedAt, publishPublicly: true },
  headers: Record<string, string> = {},
) =>
  POST(
    new Request(`${origin}/api/launch/metadata`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, ...headers },
      body: JSON.stringify(body),
    }),
  );
const count = async () =>
  (await mocks.db
    .prepare('SELECT COUNT(*) AS n FROM launch_metadata_releases')
    .first<{ n: number }>())!.n;
beforeAll(async () => {
  artworkId = Buffer.from(await crypto.subtle.digest('SHA-256', png)).toString(
    'hex',
  );
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'metadata-test',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents:
                  'export default {fetch(){return new Response("test")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'launch-metadata-test-only' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'metadata-test',
  )) as unknown as D1Database;
  await mocks.db
    .prepare(
      'CREATE TABLE workspace_projects (owner_id TEXT,id TEXT,document TEXT,updated_at TEXT,archived INTEGER DEFAULT 0,PRIMARY KEY(owner_id,id))',
    )
    .run();
  await mocks.db
    .prepare(
      'CREATE TABLE project_artwork (owner_id TEXT,id TEXT,data BLOB,mime TEXT,archived INTEGER DEFAULT 0,PRIMARY KEY(owner_id,id))',
    )
    .run();
  for (const sql of readFileSync(
    new URL('../../../../drizzle/0078_lush_rictor.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
}, 30000);
beforeEach(async () => {
  description = `Reviewed description ${++sequence}`;
  mocks.user = { userId: 'alice' };
  await mocks.db.prepare('DELETE FROM workspace_projects').run();
  await mocks.db.prepare('DELETE FROM project_artwork').run();
  const project = validateProjectDocument({
    plan: {
      ...DEFAULT_LAUNCH_PLAN,
      tokenName: 'Example',
      ticker: 'EX',
      description,
    },
    identity: {
      ...EMPTY_IDENTITY,
      artworkUrl: `/api/artwork/${artworkId}`,
      website: 'https://example.com',
    },
    options: DEFAULT_VENUE_OPTIONS,
  });
  await mocks.db
    .prepare(
      'INSERT INTO workspace_projects(owner_id,id,document,updated_at) VALUES (?,?,?,?)',
    )
    .bind('alice', 'p', JSON.stringify(project), updatedAt)
    .run();
  await mocks.db
    .prepare(
      'INSERT INTO project_artwork(owner_id,id,data,mime) VALUES (?,?,?,?)',
    )
    .bind('alice', artworkId, png, 'image/png')
    .run();
});
afterAll(async () => {
  await mf?.dispose();
});
it('requires authentication, same origin, bounded JSON and explicit publication consent', async () => {
  mocks.user = null;
  expect((await request()).status).toBe(401);
  mocks.user = { userId: 'alice' };
  expect(
    (await request(undefined, { origin: 'https://other.test' })).status,
  ).toBe(403);
  expect(
    (await request(undefined, { 'content-type': 'text/plain' })).status,
  ).toBe(415);
  expect(
    (await request({ projectId: 'p', updatedAt, publishPublicly: false }))
      .status,
  ).toBe(400);
  expect(
    (
      await request({
        projectId: 'p',
        updatedAt,
        publishPublicly: true,
        image: 'override',
      })
    ).status,
  ).toBe(400);
  expect((await request({ projectId: 'x'.repeat(2100) })).status).toBe(413);
});
it('does not publish another owner’s project, stale or archived state', async () => {
  mocks.user = { userId: 'bob' };
  expect((await request()).status).toBe(404);
  mocks.user = { userId: 'alice' };
  expect(
    (
      await request({
        projectId: 'p',
        updatedAt: '2026-10-13T00:00:00Z',
        publishPublicly: true,
      })
    ).status,
  ).toBe(409);
  await mocks.db.prepare('UPDATE workspace_projects SET archived=1').run();
  expect((await request()).status).toBe(409);
});
it('requires exact active uploaded image bytes and never fetches arbitrary artwork URLs', async () => {
  await mocks.db.prepare('UPDATE project_artwork SET archived=1').run();
  expect((await request()).status).toBe(409);
  await mocks.db
    .prepare('UPDATE project_artwork SET archived=0,data=?')
    .bind(new Uint8Array([1, 2]))
    .run();
  expect((await request()).status).toBe(409);
  const doc = JSON.parse(
    (await mocks.db
      .prepare('SELECT document FROM workspace_projects')
      .first<{ document: string }>())!.document,
  );
  doc.identity.artworkUrl = 'https://example.com/picture.png';
  await mocks.db
    .prepare('UPDATE workspace_projects SET document=?')
    .bind(JSON.stringify(doc))
    .run();
  expect((await request()).status).toBe(400);
});
it('publishes metadata and exact image without exposing private project or wallet fields', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  const result = await releaseJSON(response);
  expect(result.executionAllowed).toBe(false);
  expect(result.uri).toBe(`${origin}/api/launch/metadata/${result.id}`);
  expect(result.metadata).toMatchObject({
    name: 'Example',
    symbol: 'EX',
    description,
    image: `${result.uri}/image`,
  });
  mocks.user = null;
  const metadata = await GET(new Request(result.uri), ctx(result.id));
  expect(metadata.status).toBe(200);
  expect(metadata.headers.get('cache-control')).toContain('immutable');
  expect(metadata.headers.get('access-control-allow-origin')).toBe('*');
  expect(await metadata.json()).toEqual(result.metadata);
  expect(Object.keys(result.metadata).sort()).toEqual([
    'description',
    'image',
    'name',
    'properties',
    'symbol',
    'website',
  ]);
  const image = await imageGET(
    new Request(`${result.uri}/image`),
    ctx(result.id),
  );
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
  expect(image.headers.get('content-type')).toBe('image/png');
  expect(
    (
      await privateImageGET(
        new Request(`${origin}/api/artwork/${artworkId}`),
        ctx(artworkId),
      )
    ).status,
  ).toBe(401);
});
it('is idempotent and durable after private image removal and project changes', async () => {
  const first = await releaseJSON(await request());
  const before = await count();
  expect((await releaseJSON(await request())).id).toBe(first.id);
  expect(await count()).toBe(before);
  await expect(
    mocks.db
      .prepare('UPDATE launch_metadata_releases SET metadata=? WHERE id=?')
      .bind('{}', first.id)
      .run(),
  ).rejects.toThrow(/immutable/);
  await expect(
    mocks.db
      .prepare('DELETE FROM launch_metadata_releases WHERE id=?')
      .bind(first.id)
      .run(),
  ).rejects.toThrow(/permanent/);
  await mocks.db.prepare('DELETE FROM project_artwork').run();
  await mocks.db.prepare('DELETE FROM workspace_projects').run();
  mocks.user = null;
  expect((await GET(new Request(first.uri), ctx(first.id))).status).toBe(200);
  const image = await imageGET(
    new Request(`${first.uri}/image`),
    ctx(first.id),
  );
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
});
it('does not expose unreleased artwork hashes as public metadata or images', async () => {
  expect((await GET(new Request(origin), ctx(artworkId))).status).toBe(404);
  expect((await imageGET(new Request(origin), ctx(artworkId))).status).toBe(
    404,
  );
  expect((await GET(new Request(origin), ctx('../secrets'))).status).toBe(404);
});
it('publishes only one release for concurrent identical requests', async () => {
  const before = await count();
  const responses = await Promise.all([request(), request()]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  const [a, b] = await Promise.all(responses.map(releaseJSON));
  expect(a.id).toBe(b.id);
  expect(await count()).toBe(before + 1);
});
it('rejects a draft changed between review and insertion atomically', async () => {
  const actual = mocks.db;
  const before = await count();
  mocks.db = new Proxy(actual, {
    get(target, property) {
      if (property !== 'prepare') return Reflect.get(target, property);
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.startsWith('INSERT INTO launch_metadata_releases'))
          return statement;
        return {
          bind: (...values: unknown[]) => {
            const bound = statement.bind(...values);
            return {
              run: async () => {
                await target
                  .prepare(
                    'UPDATE workspace_projects SET archived=1 WHERE owner_id=?',
                  )
                  .bind('alice')
                  .run();
                return bound.run();
              },
            };
          },
        };
      };
    },
  });
  try {
    expect((await request()).status).toBe(409);
  } finally {
    mocks.db = actual;
  }
  expect(await count()).toBe(before);
});
it('bounds permanent image storage per owner', async () => {
  await mocks.db
    .prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100)
    INSERT INTO launch_metadata_releases(id,owner_id,project_id,source_document,metadata,image,mime,created_at)
    SELECT 'quota-'||x,'quota-owner','p','{}','{}',?,'image/png',? FROM n`)
    .bind(png, updatedAt)
    .run();
  await mocks.db
    .prepare("UPDATE workspace_projects SET owner_id='quota-owner'")
    .run();
  await mocks.db
    .prepare("UPDATE project_artwork SET owner_id='quota-owner'")
    .run();
  mocks.user = { userId: 'quota-owner' };
  expect((await request()).status).toBe(409);
  expect(
    (await mocks.db
      .prepare(
        "SELECT COUNT(*) AS n FROM launch_metadata_releases WHERE owner_id='quota-owner'",
      )
      .first<{ n: number }>())!.n,
  ).toBe(100);
});
