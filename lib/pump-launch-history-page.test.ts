import { createClient, type Client } from '@libsql/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createTursoDatabase } from '@/db/turso';
import {
  pumpHistoryPageRequest,
  readPumpHistoryPage,
  type PumpHistoryKind,
} from './pump-launch-history-page';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET as createGET } from '@/app/api/launch/pump/route';
import { GET as developerGET } from '@/app/api/launch/pump/initial-buy/route';
import { GET as holdersGET } from '@/app/api/launch/pump/holders/route';
let client: Client;
const date = '2026-10-14T00:00:00.000Z';
beforeEach(async () => {
  mocks.user = { userId: 'alice' };
  client = createClient({ url: 'file::memory:', intMode: 'number' });
  mocks.db = createTursoDatabase(client);
  await client.execute(
    'CREATE TABLE pump_launch_reviews(id TEXT PRIMARY KEY, owner_id TEXT, project_id TEXT, created_at TEXT, terms TEXT, review TEXT, simulation TEXT, state TEXT, signature TEXT, receipt TEXT, expires_at TEXT)',
  );
  for (const kind of ['create', 'developer', 'holders'] as const)
    for (let i = 0; i < 45; i++)
      await insert(kind, `${kind}-${String(i).padStart(2, '0')}`);
  await insert('holders', 'foreign-owner', 'bob');
  await insert('holders', 'foreign-project', 'alice', 'other');
});
afterEach(() => client.close());
async function insert(
  kind: PumpHistoryKind,
  id: string,
  owner = 'alice',
  projectId = 'project',
) {
  await client.execute({
    sql: 'INSERT INTO pump_launch_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    args: [
      id,
      owner,
      projectId,
      date,
      JSON.stringify(kind === 'developer' ? { maximumQuoteCostRaw: '1' } : {}),
      JSON.stringify({
        id,
        projectId,
        format: kind === 'holders' ? 'pump-create-holders-review-v1' : 'test',
      }),
      '{}',
      'review',
      null,
      null,
      '2026-10-14T00:01:00.000Z',
    ],
  });
}
const routes = {
  create: createGET,
  developer: developerGET,
  holders: holdersGET,
};
it('pages actual authenticated routes through timestamp ties without omissions, duplication or owner/project/type leakage', async () => {
  for (const kind of Object.keys(routes) as (keyof typeof routes)[]) {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const url = new URL('https://bundle.test/api/history');
      url.searchParams.set('projectId', 'project');
      url.searchParams.set('page', '1');
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = await routes[kind](new Request(url));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const page = (await response.json()) as {
        launches: { review: { id: string } }[];
        nextCursor: string | null;
      };
      expect(page.launches.length).toBeLessThanOrEqual(20);
      ids.push(...page.launches.map((r) => r.review.id));
      cursor = page.nextCursor;
      if (ids.length === 20) await insert(kind, `${kind}-newer`);
    } while (cursor);
    expect(ids).toEqual(
      Array.from(
        { length: 45 },
        (_, i) => `${kind}-${String(44 - i).padStart(2, '0')}`,
      ),
    );
    expect(new Set(ids).size).toBe(45);
  }
});
it('retains legacy response shape and refuses malformed or wrong-scope cursors before a database read', async () => {
  const legacy = (await (
    await createGET(new Request('https://bundle.test/?projectId=project'))
  ).json()) as { launches: unknown[] };
  expect(Object.keys(legacy)).toEqual(['launches']);
  expect(legacy.launches).toHaveLength(20);
  const first = (await (
    await holdersGET(
      new Request('https://bundle.test/?projectId=project&page=1'),
    )
  ).json()) as { nextCursor: string };
  for (const query of [
    'page=2',
    'page=1&page=1',
    'cursor=x',
    'page=1&cursor=bad',
    'page=1&cursor=' + first.nextCursor + '&cursor=x',
  ])
    expect(
      (
        await holdersGET(
          new Request('https://bundle.test/?projectId=project&' + query),
        )
      ).status,
    ).toBe(400);
  expect(
    (
      await createGET(
        new Request(
          'https://bundle.test/?projectId=project&page=1&cursor=' +
            first.nextCursor,
        ),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await holdersGET(
        new Request(
          'https://bundle.test/?projectId=other&page=1&cursor=' +
            first.nextCursor,
        ),
      )
    ).status,
  ).toBe(400);
  mocks.user = null;
  expect(
    (
      await holdersGET(
        new Request('https://bundle.test/?projectId=project&page=1'),
      )
    ).status,
  ).toBe(401);
});
it('treats a cursor only as position and returns no other owner data even if reused', async () => {
  const page = await readPumpHistoryPage(
    mocks.db,
    'alice',
    'project',
    'holders',
    { before: null },
    (r: { id: string }) => r.id,
  );
  const params = new URLSearchParams({ page: '1', cursor: page.nextCursor! });
  expect(
    (
      await readPumpHistoryPage(
        mocks.db,
        'bob',
        'project',
        'holders',
        pumpHistoryPageRequest(params, 'project', 'holders')!,
        (r: { id: string }) => r.id,
      )
    ).launches,
  ).toEqual(['foreign-owner']);
  expect(() =>
    pumpHistoryPageRequest(
      new URLSearchParams({ page: '1', cursor: page.nextCursor! + '=' }),
      'project',
      'holders',
    ),
  ).toThrow('Invalid saved');
});
