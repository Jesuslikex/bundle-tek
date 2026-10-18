import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { layerUiFixture } from '../test/launch-layer-ui-fixture';
import { layerTestStorage } from '../test/launch-layer-storage';
import { listImportedLayerTargets } from './launch-layer-targets-service';
import { parseImportedLayerTargets } from './launch-layer-targets';
const state = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as D1Database | null,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => state.user,
}));
vi.mock('@/db', () => ({ getD1: () => state.db }));
import { GET } from '../app/api/launch/layers/route';
let f: ReturnType<typeof layerUiFixture>,
  storage: Awaited<ReturnType<typeof layerTestStorage>>;
const source = () => ({
  projectId: f.selection.projectId,
  projectUpdatedAt: f.updatedAt,
});
const get = (
  query = 'targets=' + encodeURIComponent(JSON.stringify(source())),
) => GET(new Request('https://bundle.test/api/launch/layers?' + query));
async function add(
  id = 'target-a',
  owner = 'alice',
  chain = 'Solana',
  archived = 0,
) {
  const mint = chain === 'Solana' ? f.address(90) : '0x' + '12'.repeat(20);
  await storage.db
    .prepare(
      'INSERT INTO imported_token_projects(owner_id,id,chain,address,document,revision,archived,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .bind(
      owner,
      id,
      chain,
      mint,
      JSON.stringify({
        format: 'imported-token-project-v1',
        executionAllowed: false,
        token: { chain, address: mint, name: 'Saved token', symbol: 'SAVE' },
        tradeSettings: { privateExample: 'not returned' },
      }),
      3,
      archived,
      f.updatedAt,
    )
    .run();
}
beforeEach(async () => {
  f = layerUiFixture();
  f.document.plan.scheduled = true;
  storage = await layerTestStorage(f);
  await storage.client.execute(
    'ALTER TABLE imported_token_projects ADD COLUMN updated_at TEXT',
  );
  state.user = { userId: 'alice' };
  state.db = storage.db;
});
afterEach(() => {
  storage.client.close();
  vi.restoreAllMocks();
});
it('returns only compact active owned Solana choices through the real authenticated GET without writes', async () => {
  await add();
  await add('foreign', 'bob');
  await add('archived', 'alice', 'Solana', 1);
  await add('bsc', 'alice', 'BSC');
  const before = await storage.client.execute('SELECT total_changes() AS n');
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = (await response.json()) as { targets: unknown };
  const targets = parseImportedLayerTargets(body.targets, source());
  expect(targets.items).toEqual([
    {
      id: 'target-a',
      revision: 3,
      chain: 'Solana',
      mint: f.address(90),
      name: 'Saved token',
      symbol: 'SAVE',
    },
  ]);
  expect(targets.hasMore).toBe(false);
  expect(JSON.stringify(body)).not.toContain('privateExample');
  expect(parseImportedLayerTargets(body.targets, source()).signingAllowed).toBe(
    false,
  );
  expect(
    (await storage.client.execute('SELECT total_changes() AS n')).rows,
  ).toEqual(before.rows);
});
it('requires authentication, exact query shape, bounded JSON and the owned current scheduled source', async () => {
  state.user = null;
  expect((await get()).status).toBe(401);
  state.user = { userId: 'alice' };
  for (const query of [
    'targets=bad',
    'targets={}&targets={}',
    'targets={}&extra=1',
  ])
    expect((await get(query)).status).toBe(400);
  expect(
    (await get('targets=' + encodeURIComponent('x'.repeat(2049)))).status,
  ).toBe(413);
  expect(
    (
      await get(
        'targets=' +
          encodeURIComponent(
            JSON.stringify({ ...source(), projectId: 'foreign' }),
          ),
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await get(
        'targets=' +
          encodeURIComponent(
            JSON.stringify({
              ...source(),
              projectUpdatedAt: '2026-10-18T00:00:00.000Z',
            }),
          ),
      )
    ).status,
  ).toBe(409);
  f.document.plan.scheduled = false;
  await storage.db
    .prepare('UPDATE workspace_projects SET document=?')
    .bind(JSON.stringify(f.document))
    .run();
  expect((await get()).status).toBe(409);
});
it('reports the exact 100-choice window and does not silently call it complete', async () => {
  await storage.db.batch(
    Array.from({ length: 101 }, (_, i) =>
      storage.db
        .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,?,?,?,?,?)')
        .bind(
          'alice',
          'target-' + String(i).padStart(3, '0'),
          'Solana',
          f.address(i + 10),
          JSON.stringify({
            format: 'imported-token-project-v1',
            executionAllowed: false,
            token: {
              chain: 'Solana',
              address: f.address(i + 10),
              name: 'Token ' + i,
              symbol: 'T',
            },
          }),
          1,
          0,
          f.updatedAt,
        ),
    ),
  );
  const value = await listImportedLayerTargets(storage.db, 'alice', source());
  expect(value.items).toHaveLength(100);
  expect(value.hasMore).toBe(true);
  expect(value.items[0].id).toBe('target-000');
  expect(value.items.at(-1)?.id).toBe('target-099');
  expect(value.nextCursor?.id).toBe('target-099');
  const next = await listImportedLayerTargets(storage.db, 'alice', {
    ...source(),
    cursor: value.nextCursor!,
  });
  expect(next.items.map((item) => item.id)).toEqual(['target-100']);
  expect(next.hasMore).toBe(false);
  expect(next.nextCursor).toBeNull();
  expect(
    new Set([...value.items, ...next.items].map((item) => item.id)).size,
  ).toBe(101);
  const searched = await listImportedLayerTargets(storage.db, 'alice', {
    ...source(),
    search: 'Token 100',
  });
  expect(searched.items.map((item) => item.id)).toEqual(['target-100']);
  await expect(
    listImportedLayerTargets(storage.db, 'alice', {
      ...source(),
      search: 'Token',
      cursor: value.nextCursor!,
    }),
  ).rejects.toMatchObject({ status: 400 });
  await storage.db
    .prepare('UPDATE imported_token_projects SET revision=2 WHERE id=?')
    .bind(value.nextCursor!.id)
    .run();
  await expect(
    listImportedLayerTargets(storage.db, 'alice', {
      ...source(),
      cursor: value.nextCursor!,
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it('withholds the entire list when a visible imported record is inconsistent', async () => {
  await add();
  await storage.db
    .prepare('UPDATE imported_token_projects SET address=?')
    .bind(f.address(91))
    .run();
  const response = await get();
  expect(response.status).toBe(503);
  expect(await response.json()).not.toHaveProperty('targets');
});
it('rechecks source after listing and rejects a concurrent source change', async () => {
  await add();
  const original = storage.db.prepare.bind(storage.db);
  vi.spyOn(storage.db, 'prepare').mockImplementation((sql: string) => {
    const statement = original(sql);
    if (!sql.includes('FROM imported_token_projects')) return statement;
    const bind = statement.bind.bind(statement);
    statement.bind = (...args) => {
      const bound = bind(...args);
      const all = bound.all.bind(bound);
      bound.all = async <T = Record<string, unknown>>() => {
        const result = await all<T>();
        await original('UPDATE workspace_projects SET archived=1').run();
        return result;
      };
      return bound;
    };
    return statement;
  });
  expect((await get()).status).toBe(409);
});
it('rejects substituted context, permissions and duplicate target identities in client parsing', async () => {
  await add();
  const value = await listImportedLayerTargets(storage.db, 'alice', source());
  for (const bad of [
    { ...value, projectId: 'foreign' },
    { ...value, signingAllowed: true },
    { ...value, fundingAllowed: true },
    { ...value, items: [...value.items, ...value.items] },
    { ...value, items: [{ ...value.items[0], revision: 0 }] },
    { ...value, hasMore: undefined },
  ])
    expect(() => parseImportedLayerTargets(bad, source())).toThrow();
});

it('searches owned names, symbols and mint text literally with normalized bounded input', async () => {
  await add();
  for (const search of ['saved', 'SAVE', f.address(90).slice(-12)])
    expect(
      (
        await listImportedLayerTargets(storage.db, 'alice', {
          ...source(),
          search,
        })
      ).items,
    ).toHaveLength(1);
  expect(
    (
      await listImportedLayerTargets(storage.db, 'alice', {
        ...source(),
        search: '  missing  ',
      })
    ).search,
  ).toBe('missing');
  expect(
    (
      await listImportedLayerTargets(storage.db, 'alice', {
        ...source(),
        search: '%',
      })
    ).items,
  ).toHaveLength(0);
  expect(
    (
      await listImportedLayerTargets(storage.db, 'alice', {
        ...source(),
        search: "' OR 1=1 --",
      })
    ).items,
  ).toHaveLength(0);
  await expect(
    listImportedLayerTargets(storage.db, 'alice', {
      ...source(),
      search: 'x'.repeat(81),
    }),
  ).rejects.toMatchObject({ status: 400 });
});
it('rejects foreign, stale and cross-launch cursor anchors without broadening ownership', async () => {
  await add('foreign-anchor', 'bob');
  const cursor = {
    version: 1 as const,
    ...source(),
    search: '',
    id: 'foreign-anchor',
    revision: 3,
    updatedAt: f.updatedAt,
  };
  await expect(
    listImportedLayerTargets(storage.db, 'alice', { ...source(), cursor }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    listImportedLayerTargets(storage.db, 'alice', {
      ...source(),
      cursor: { ...cursor, projectId: 'another-source' },
    }),
  ).rejects.toMatchObject({ status: 400 });
  await add('own-anchor');
  await storage.db
    .prepare('UPDATE imported_token_projects SET archived=1 WHERE id=?')
    .bind('own-anchor')
    .run();
  await expect(
    listImportedLayerTargets(storage.db, 'alice', {
      ...source(),
      cursor: { ...cursor, id: 'own-anchor' },
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it('refuses substituted page/search echoes and malformed continuation tails', async () => {
  await add();
  const query = { ...source(), search: 'SAVE' };
  const page = await listImportedLayerTargets(storage.db, 'alice', query);
  expect(() =>
    parseImportedLayerTargets({ ...page, search: '' }, query),
  ).toThrow();
  const cursor = {
    version: 1 as const,
    ...source(),
    search: 'SAVE',
    id: 'own-anchor',
    revision: 1,
    updatedAt: f.updatedAt,
  };
  expect(() =>
    parseImportedLayerTargets({ ...page, pageCursor: cursor }, query),
  ).toThrow();
  expect(() =>
    parseImportedLayerTargets(
      { ...page, hasMore: true, nextCursor: cursor },
      query,
    ),
  ).toThrow();
});
