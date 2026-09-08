import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { DEFAULT_LAUNCH_PLAN } from '@/lib/launch-plan';
import type { WorkspaceProject } from '@/lib/workspace-project';

const mocks = vi.hoisted(() => ({
  user: null as { userId: string; email: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET, POST } from './route';

let mf: Miniflare;
const payload = (overrides = {}) => ({
  id: 'test-project',
  plan: DEFAULT_LAUNCH_PLAN,
  archived: false,
  expectedUpdatedAt: null,
  ...overrides,
});
const post = (body: unknown, headers = {}) =>
  POST(
    new Request('http://localhost/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
const read = async (response: Response) =>
  (await response.json()) as {
    project: WorkspaceProject;
    projects: WorkspaceProject[];
  };

beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'workspace-test',
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
          env: { DB: { type: 'd1', id: 'workspace-test-only' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'workspace-test',
  )) as unknown as D1Database;
  const migration = readFileSync(
    new URL(
      '../../../drizzle/0005_special_marten_broadcloak.sql',
      import.meta.url,
    ),
    'utf8',
  );
  for (const statement of migration
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(statement).run();
}, 30000);
beforeEach(async () => {
  mocks.user = { userId: 'alice', email: 'alice@example.test' };
  await mocks.db.prepare('DELETE FROM workspace_projects').run();
});
afterAll(async () => {
  await mf?.dispose();
});

describe('owner-scoped project API on actual local D1', () => {
  it('requires authentication and returns uncached responses', async () => {
    mocks.user = null;
    expect((await GET()).status).toBe(401);
    const response = await post(payload());
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('creates, lists, updates, archives and restores a complete document', async () => {
    const created = await post(
      payload({ identity: { website: 'https://example.com' } }),
    );
    expect(created.status).toBe(200);
    let { project } = await read(created);
    expect(project.identity.website).toBe('https://example.com');
    expect((await read(await GET())).projects).toHaveLength(1);
    for (const archived of [true, false]) {
      const response = await post({
        ...project,
        archived,
        expectedUpdatedAt: project.updatedAt,
      });
      expect(response.status).toBe(200);
      const next = (await read(response)).project;
      expect(next.archived).toBe(archived);
      expect(next.updatedAt > project.updatedAt).toBe(true);
      project = next;
    }
  });
  it('isolates owners even with matching project IDs and rejects cross-owner updates', async () => {
    const { project } = await read(await post(payload()));
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await read(await GET())).projects).toHaveLength(0);
    expect(
      (await post(payload({ expectedUpdatedAt: project.updatedAt }))).status,
    ).toBe(409);
    expect((await post(payload())).status).toBe(200);
    expect((await read(await GET())).projects).toHaveLength(1);
  });
  it('rejects duplicate creates and allows exactly one concurrent revision update', async () => {
    const { project } = await read(await post(payload()));
    expect((await post(payload())).status).toBe(409);
    const responses = await Promise.all(
      [1, 2].map(() => post(payload({ expectedUpdatedAt: project.updatedAt }))),
    );
    expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
  });
  it('advances save revisions when the clock has not advanced', async () => {
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-09-08T00:00:00.000Z'));
    try {
      const { project } = await read(await post(payload()));
      const next = await read(
        await post(payload({ expectedUpdatedAt: project.updatedAt })),
      );
      expect(next.project.updatedAt).toBe('2026-09-08T00:00:00.001Z');
      expect(
        (await post(payload({ expectedUpdatedAt: project.updatedAt }))).status,
      ).toBe(409);
    } finally {
      clock.mockRestore();
    }
  });
  it('does not expose storage exceptions', async () => {
    const database = mocks.db;
    mocks.db = {
      prepare: () => {
        throw new Error('internal secret storage failure');
      },
    } as unknown as D1Database;
    try {
      for (const response of [await GET(), await post(payload())]) {
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain('internal secret');
      }
    } finally {
      mocks.db = database;
    }
  });
  it('rejects invalid documents, cross-origin and non-JSON writes', async () => {
    expect(
      (await post(payload({ identity: { artworkUrl: 'javascript:alert(1)' } })))
        .status,
    ).toBe(400);
    expect(
      (await post(payload(), { origin: 'https://evil.example' })).status,
    ).toBe(403);
    expect(
      (await post(payload(), { 'content-type': 'text/plain' })).status,
    ).toBe(415);
    expect((await post(payload({ padding: 'x'.repeat(25000) }))).status).toBe(
      413,
    );
    expect(
      (await post(payload({ expectedUpdatedAt: 'not-a-revision' }))).status,
    ).toBe(400);
    expect((await read(await GET())).projects).toHaveLength(0);
  });
  it('enforces the per-owner project cap atomically without affecting other owners', async () => {
    const results = await Promise.all(
      Array.from({ length: 102 }, (_, i) =>
        post(payload({ id: `project-${i}` })),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(100);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    mocks.user = { userId: 'bob', email: 'bob@example.test' };
    expect((await post(payload())).status).toBe(200);
  }, 15000);
});
