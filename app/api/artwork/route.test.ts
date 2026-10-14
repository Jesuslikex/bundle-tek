import { beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import {
  MAX_ARTWORK_BYTES,
  MAX_ARTWORK_STORAGE,
  inspectArtwork,
} from '@/lib/artwork';
import { validateProjectDocument } from '@/lib/workspace-project';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
const mocks = vi.hoisted(() => ({
  user: null as null | { userId: string },
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { POST, GET as listArtwork, PATCH } from './route';
import { GET } from './[id]/route';
let mf: Miniflare;
const png = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2QAAAAASUVORK5CYII=',
    'base64',
  ),
);
const upload = (
  bytes: Uint8Array = png,
  headers: Record<string, string> = {},
) =>
  POST(
    new Request('http://localhost/api/artwork', {
      method: 'POST',
      headers: { 'content-type': 'image/png', ...headers },
      body: new Uint8Array(bytes).buffer,
    }),
  );
const read = (id: string) =>
  GET(new Request(`http://localhost/api/artwork/${id}`), {
    params: Promise.resolve({ id }),
  });
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'artwork-test',
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
          env: { DB: { type: 'd1', id: 'artwork-test-only' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'artwork-test',
  )) as unknown as D1Database;
  for (const sql of readFileSync(
    new URL(
      '../../../drizzle/0005_special_marten_broadcloak.sql',
      import.meta.url,
    ),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
  for (const sql of readFileSync(
    new URL('../../../drizzle/0009_clever_leper_queen.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
  for (const sql of readFileSync(
    new URL('../../../drizzle/0032_artwork_archive.sql', import.meta.url),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
}, 30000);
beforeEach(async () => {
  mocks.user = { userId: 'alice' };
  await mocks.db.prepare('DELETE FROM project_artwork').run();
  await mocks.db.prepare('DELETE FROM workspace_projects').run();
});
afterAll(async () => {
  await mf?.dispose();
});
it('requires authentication and rejects cross-origin, executable and oversized bodies', async () => {
  mocks.user = null;
  expect((await upload()).status).toBe(401);
  expect((await read('a'.repeat(64))).status).toBe(401);
  mocks.user = { userId: 'alice' };
  expect((await upload(png, { origin: 'https://evil.test' })).status).toBe(403);
  expect((await upload(png, { 'content-type': 'image/svg+xml' })).status).toBe(
    415,
  );
  expect(
    (await upload(new TextEncoder().encode('<script>alert(1)</script>')))
      .status,
  ).toBe(400);
  expect((await upload(new Uint8Array(MAX_ARTWORK_BYTES + 1))).status).toBe(
    413,
  );
  expect(
    (
      await mocks.db
        .prepare('SELECT COUNT(*) AS n FROM project_artwork')
        .first<{ n: number }>()
    )?.n,
  ).toBe(0);
});
it('persists exact image bytes, deduplicates per owner and prevents other accounts reading them', async () => {
  const response = await upload();
  expect(response.status).toBe(200);
  const { artwork } = (await response.json()) as {
    artwork: { id: string; url: string };
  };
  expect(
    validateProjectDocument({
      plan: DEFAULT_LAUNCH_PLAN,
      identity: { artworkUrl: artwork.url },
    }).identity.artworkUrl,
  ).toBe(artwork.url);
  expect((await upload()).status).toBe(200);
  expect(
    (
      await mocks.db
        .prepare('SELECT COUNT(*) AS n FROM project_artwork')
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
  const image = await read(artwork.id);
  expect(image.headers.get('content-type')).toBe('image/png');
  expect(image.headers.get('cache-control')).toContain('private');
  expect(image.headers.get('x-content-type-options')).toBe('nosniff');
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
  mocks.user = { userId: 'bob' };
  expect((await read(artwork.id)).status).toBe(404);
  expect((await upload()).status).toBe(200);
  expect(
    (
      await mocks.db
        .prepare('SELECT COUNT(*) AS n FROM project_artwork')
        .first<{ n: number }>()
    )?.n,
  ).toBe(2);
});
it('enforces atomic per-account storage caps while allowing existing images to be reused', async () => {
  const { artwork } = (await (await upload()).json()) as {
    artwork: { id: string };
  };
  await mocks.db
    .prepare('UPDATE project_artwork SET byte_length=?')
    .bind(MAX_ARTWORK_STORAGE)
    .run();
  expect((await upload()).status).toBe(200);
  const different = new Uint8Array(png);
  different[different.length - 1] ^= 1;
  expect((await upload(different)).status).toBe(409);
  expect((await read(artwork.id)).status).toBe(200);
  await mocks.db.prepare('DELETE FROM project_artwork').run();
  await mocks.db
    .prepare(`WITH RECURSIVE entries(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM entries WHERE n<100)
    INSERT INTO project_artwork(owner_id,id,data,mime,byte_length,created_at)
    SELECT 'alice',CAST(n AS TEXT),?,'image/png',?,'2026-10-09' FROM entries`)
    .bind(png, png.length)
    .run();
  expect((await upload()).status).toBe(409);
});
it('rejects oversized dimensions, malformed JPEG sections and unsafe relative artwork paths', () => {
  const big = new Uint8Array(png);
  new DataView(big.buffer).setUint32(16, 4097);
  expect(() => inspectArtwork(big)).toThrow('dimensions');
  expect(() =>
    inspectArtwork(new Uint8Array([255, 216, 255, 192, 255, 255])),
  ).toThrow();
  for (const url of [
    '/api/artwork/no',
    '//evil.test/pic.png',
    '/api/artwork/' + 'a'.repeat(64) + '?x=1',
  ])
    expect(() =>
      validateProjectDocument({
        plan: DEFAULT_LAUNCH_PLAN,
        identity: { artworkUrl: url },
      }),
    ).toThrow();
});
it('lists owned metadata without image bytes and counts active and archived project references only for that owner', async () => {
  const { artwork } = (await (await upload()).json()) as {
    artwork: { id: string; url: string };
  };
  for (const [owner, id, archived, document] of [
    [
      'alice',
      'active',
      0,
      JSON.stringify({ identity: { artworkUrl: artwork.url } }),
    ],
    [
      'alice',
      'archived',
      1,
      JSON.stringify({ identity: { artworkUrl: artwork.url } }),
    ],
    ['alice', 'invalid', 0, 'broken-json'],
    [
      'bob',
      'other',
      0,
      JSON.stringify({ identity: { artworkUrl: artwork.url } }),
    ],
  ] as const)
    await mocks.db
      .prepare(
        'INSERT INTO workspace_projects(owner_id,id,archived,document,updated_at) VALUES (?,?,?,?,?)',
      )
      .bind(owner, id, archived, document, '2026-10-10')
      .run();
  const response = await listArtwork(new Request('http://localhost:3000/api/artwork'));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('no-store');
  const body = (await response.json()) as {
    artwork: Array<{
      id: string;
      url: string;
      activeProjects: number;
      archivedProjects: number;
      bytes: number;
    }>;
    usage: { count: number; bytes: number };
  };
  expect(body.artwork).toHaveLength(1);
  expect(body.artwork[0]).toMatchObject({
    id: artwork.id,
    url: artwork.url,
    activeProjects: 1,
    archivedProjects: 1,
    bytes: png.length,
  });
  expect(body.artwork[0]).not.toHaveProperty('data');
  expect(body.usage).toMatchObject({ count: 1, bytes: png.length });
  expect(
    (
      await mocks.db
        .prepare('SELECT COUNT(*) AS n FROM project_artwork')
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
  mocks.user = { userId: 'bob' };
  expect(await (await listArtwork(new Request('http://localhost:3000/api/artwork'))).json()).toMatchObject({
    artwork: [],
    usage: { count: 0, bytes: 0 },
  });
  await upload();
  const other = (await (await listArtwork(new Request('http://localhost:3000/api/artwork'))).json()) as typeof body;
  expect(other.artwork[0]).toMatchObject({
    activeProjects: 1,
    archivedProjects: 0,
  });
});
it('requires sign-in for the library and reports storage failures instead of an empty collection', async () => {
  mocks.user = null;
  expect((await listArtwork(new Request('http://localhost:3000/api/artwork'))).status).toBe(401);
  mocks.user = { userId: 'alice' };
  await mocks.db
    .prepare('ALTER TABLE workspace_projects RENAME TO projects_hidden')
    .run();
  try {
    const response = await listArtwork(new Request('http://localhost:3000/api/artwork'));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('projects_hidden');
  } finally {
    await mocks.db
      .prepare('ALTER TABLE projects_hidden RENAME TO workspace_projects')
      .run();
  }
});

const manage = (
  id: string,
  revision: number,
  action = 'archive',
  headers: Record<string, string> = {},
) =>
  PATCH(
    new Request('http://localhost/api/artwork', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ id, expectedRevision: revision, action }),
    }),
  );
const archivedList = () =>
  listArtwork(new Request('http://localhost/api/artwork?view=archived'));
it('archives and restores owned images with stable bytes, quota and saved project references', async () => {
  const { artwork } = (await (await upload()).json()) as {
    artwork: { id: string; url: string };
  };
  await mocks.db
    .prepare(
      'INSERT INTO workspace_projects(owner_id,id,archived,document,updated_at) VALUES (?,?,?,?,?)',
    )
    .bind(
      'alice',
      'referenced',
      0,
      JSON.stringify({ identity: { artworkUrl: artwork.url } }),
      '2026-10-10',
    )
    .run();
  expect(await (await manage(artwork.id, 1)).json()).toMatchObject({
    id: artwork.id,
    revision: 2,
    archived: true,
  });
  expect(await (await listArtwork(new Request('http://localhost:3000/api/artwork'))).json()).toMatchObject({
    artwork: [],
    usage: { count: 1, bytes: png.length, archivedCount: 1 },
  });
  const saved = (await (await archivedList()).json()) as { artwork: unknown[] };
  expect(saved.artwork).toEqual([
    expect.objectContaining({
      id: artwork.id,
      revision: 2,
      archived: true,
      activeProjects: 1,
    }),
  ]);
  expect(new Uint8Array(await (await read(artwork.id)).arrayBuffer())).toEqual(
    png,
  );
  // Reupload deduplicates without silently restoring an archived image.
  expect(await (await upload()).json()).toMatchObject({
    artwork: { id: artwork.id, archived: true, revision: 2 },
  });
  expect((await manage(artwork.id, 1, 'restore')).status).toBe(409);
  expect((await manage(artwork.id, 2, 'restore')).status).toBe(200);
  expect(await (await listArtwork(new Request('http://localhost:3000/api/artwork'))).json()).toMatchObject({
    artwork: [
      expect.objectContaining({
        archived: false,
        revision: 3,
        activeProjects: 1,
      }),
    ],
    usage: { count: 1, bytes: png.length, archivedCount: 0 },
  });
});
it('rejects other owners, stale concurrent changes and unauthenticated or invalid management requests', async () => {
  const { artwork } = (await (await upload()).json()) as {
    artwork: { id: string };
  };
  mocks.user = { userId: 'bob' };
  expect((await manage(artwork.id, 1)).status).toBe(409);
  expect(await (await archivedList()).json()).toMatchObject({ artwork: [] });
  mocks.user = null;
  expect((await manage(artwork.id, 1)).status).toBe(401);
  mocks.user = { userId: 'alice' };
  expect(
    (await manage(artwork.id, 1, 'archive', { origin: 'https://other.test' }))
      .status,
  ).toBe(403);
  expect((await manage(artwork.id, 1, 'delete')).status).toBe(400);
  expect((await manage(artwork.id, 0)).status).toBe(400);
  expect((await manage('bad', 1)).status).toBe(400);
  expect(
    (await listArtwork(new Request('http://localhost/api/artwork?view=bad')))
      .status,
  ).toBe(400);
  const results = await Promise.all([
    manage(artwork.id, 1),
    manage(artwork.id, 1),
  ]);
  expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
    200, 409,
  ]);
  expect((await manage(artwork.id, 2)).status).toBe(409);
  expect((await manage(artwork.id, 2, 'restore')).status).toBe(200);
});
