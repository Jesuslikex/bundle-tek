import { createClient, type Client } from '@libsql/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTursoDatabase } from '@/db/turso';
import {
  launchMetadataReleaseId,
  releaseLaunchMetadata,
} from '@/lib/launch-metadata-release';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  validateProjectDocument,
} from '@/lib/workspace-project';

const mocks = vi.hoisted(() => ({
  user: 'alice' as string | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => (mocks.user ? { userId: mocks.user } : null),
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET } from './route';

let client: Client,
  id: string,
  source: ReturnType<typeof validateProjectDocument>;
const updatedAt = '2026-10-14T00:00:00.000Z',
  origin = 'https://bundle.test';
const png = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2QAAAAASUVORK5CYII=',
    'base64',
  ),
);
const request = (version = updatedAt) =>
  GET(
    new Request(
      `${origin}/api/launch/metadata?${new URLSearchParams({ projectId: 'project', updatedAt: version })}`,
    ),
  );

beforeEach(async () => {
  mocks.user = 'alice';
  client = createClient({ url: 'file::memory:' });
  mocks.db = createTursoDatabase(client);
  await client.execute(
    'CREATE TABLE workspace_projects (owner_id TEXT,id TEXT,updated_at TEXT,archived INTEGER,document TEXT)',
  );
  await client.execute(
    'CREATE TABLE launch_metadata_releases (id TEXT PRIMARY KEY,owner_id TEXT,project_id TEXT,source_document TEXT,metadata TEXT,image BLOB,mime TEXT,created_at TEXT)',
  );
  await client.execute(
    'CREATE TABLE project_artwork (owner_id TEXT,id TEXT,data BLOB,mime TEXT,archived INTEGER)',
  );
  const imageId = Buffer.from(
    await crypto.subtle.digest('SHA-256', png),
  ).toString('hex');
  source = validateProjectDocument({
    plan: { ...DEFAULT_LAUNCH_PLAN, tokenName: 'Token', ticker: 'TOK' },
    identity: { ...EMPTY_IDENTITY, artworkUrl: `/api/artwork/${imageId}` },
    options: DEFAULT_VENUE_OPTIONS,
  });
  await client.execute({
    sql: 'INSERT INTO project_artwork VALUES (?,?,?,?,?)',
    args: ['alice', imageId, png, 'image/png', 0],
  });
  id = await launchMetadataReleaseId('alice', 'project', origin, source);
  await client.execute({
    sql: 'INSERT INTO workspace_projects VALUES (?,?,?,?,?)',
    args: ['alice', 'project', updatedAt, 0, JSON.stringify(source)],
  });
  await client.execute({
    sql: 'INSERT INTO launch_metadata_releases VALUES (?,?,?,?,?,?,?,?)',
    args: [
      id,
      'alice',
      'project',
      JSON.stringify(source),
      JSON.stringify({
        name: 'Token',
        symbol: 'TOK',
        description: source.plan.description,
        image: `${origin}/api/launch/metadata/${id}/image`,
      }),
      png,
      'image/png',
      updatedAt,
    ],
  });
});

it('recovers a real publication by its original deterministic identifier', async () => {
  await client.execute('DELETE FROM launch_metadata_releases');
  const published = await releaseLaunchMetadata(
    mocks.db,
    'alice',
    'project',
    updatedAt,
    origin,
  );
  const legacyPreimage = JSON.stringify([
    'launch-metadata-v1',
    'alice',
    'project',
    origin,
    {
      name: source.plan.tokenName,
      symbol: source.plan.ticker,
      description: source.plan.description,
    },
    source.identity.artworkUrl.split('/').at(-1),
  ]);
  const oldId = Buffer.from(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(legacyPreimage),
    ),
  ).toString('hex');
  expect(published.id).toBe(oldId);
  expect(published.id).toBe(id);
  expect(await (await request()).json()).toMatchObject({
    release: { id: published.id, uri: published.uri },
  });
});
afterEach(() => client.close());

it('recovers a release after funding-only changes without writing or changing consent', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    release: { id, executionAllowed: false },
  });
  expect(response.headers.get('cache-control')).toBe('no-store');
  const changed = validateProjectDocument({
    ...source,
    plan: { ...source.plan, scheduled: !source.plan.scheduled },
  });
  await client.execute({
    sql: 'UPDATE workspace_projects SET document=?',
    args: [JSON.stringify(changed)],
  });
  expect(await (await request()).json()).toMatchObject({ release: { id } });
  mocks.user = 'bob';
  expect(await (await request()).json()).toEqual({ release: null });
  mocks.user = null;
  expect((await request()).status).toBe(401);
  mocks.user = 'alice';
  expect(await (await request('2026-10-15T00:00:00.000Z')).json()).toEqual({
    release: null,
  });
  const identityChange = validateProjectDocument({
    ...source,
    plan: { ...source.plan, ticker: 'NEW' },
  });
  await client.execute({
    sql: 'UPDATE workspace_projects SET document=?',
    args: [JSON.stringify(identityChange)],
  });
  expect(await (await request()).json()).toEqual({ release: null });
  expect(
    Number(
      (
        await client.execute(
          'SELECT COUNT(*) AS n FROM launch_metadata_releases',
        )
      ).rows[0].n,
    ),
  ).toBe(1);
});

it('refuses archived projects and corrupted released metadata', async () => {
  await client.execute('UPDATE workspace_projects SET archived=1');
  expect(await (await request()).json()).toEqual({ release: null });
  await client.execute('UPDATE workspace_projects SET archived=0');
  await client.execute({
    sql: 'UPDATE launch_metadata_releases SET metadata=?',
    args: [JSON.stringify({ image: 'https://elsewhere.test/image' })],
  });
  expect((await request()).status).toBe(503);
  expect((await request('invalid')).status).toBe(400);
});

it('refuses if the saved project changes while released artwork is being verified', async () => {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let reads = 0;
  const spy = vi
    .spyOn(crypto.subtle, 'digest')
    .mockImplementation(async (...args) => {
      if (++reads === 2)
        await client.execute({
          sql: 'UPDATE workspace_projects SET updated_at=?',
          args: ['2026-10-15T00:00:00.000Z'],
        });
      return digest(...args);
    });
  try {
    expect((await request()).status).toBe(409);
  } finally {
    spy.mockRestore();
  }
});
