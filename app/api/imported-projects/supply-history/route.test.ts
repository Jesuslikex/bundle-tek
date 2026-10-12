import { beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  supplyFixture,
  supplyScope,
  supplyProject,
  supplyWallet,
} from '../../../../test/supply-history-fixture';
import {
  captureSupply,
  supplyScopeId,
  type SupplyHistoryRow,
} from '@/lib/supply-history';
const mocks = vi.hoisted(() => ({
  user: { userId: 'one' } as { userId: string } | null,
  db: null as unknown as D1Database,
  observe: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/supply-partition', async (original) => ({
  ...(await original<typeof import('@/lib/supply-partition')>()),
  observeSupplyPartition: mocks.observe,
}));
import { GET, POST } from './route';
let mf: Miniflare;
const migration = readFileSync(
  'drizzle/0063_imported_supply_history.sql',
  'utf8',
)
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean);
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'supply-tests',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents: 'export default {fetch(){return new Response("ok")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'supply-test-only' } },
        },
      },
    ],
  });
  mocks.db = await mf.getD1Database('DB', 'supply-tests');
  await mocks.db
    .prepare(
      'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,revision INTEGER,archived INTEGER,chain TEXT,address TEXT)',
    )
    .run();
  await mocks.db
    .prepare(
      'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
    )
    .run();
});
afterAll(async () => mf?.dispose());
beforeEach(async () => {
  mocks.user = { userId: 'one' };
  mocks.observe.mockReset().mockResolvedValue(supplyFixture());
  for (const table of [
    'imported_supply_observations',
    'imported_supply_scopes',
    'imported_supply_read_gates',
  ])
    await mocks.db.prepare('DROP TABLE IF EXISTS ' + table).run();
  for (const statement of migration) await mocks.db.prepare(statement).run();
  for (const table of ['imported_token_projects', 'workspace_wallets'])
    await mocks.db.prepare('DELETE FROM ' + table).run();
  await mocks.db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,1,0,?,?)')
    .bind('one', supplyProject, 'Solana', supplyScope.mint)
    .run();
  for (const w of supplyScope.wallets)
    await mocks.db
      .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,1,0)')
      .bind('one', 'Solana', w.address)
      .run();
});
const post = (wallets = supplyScope.wallets) =>
  new Request('http://localhost/api/imported-projects/supply-history', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: supplyProject, revision: 1, wallets }),
  });
const get = (extra = '') =>
  new Request(
    `http://localhost/api/imported-projects/supply-history?id=${supplyProject}&revision=1${extra}`,
  );
const unlock = () =>
  mocks.db.prepare('DELETE FROM imported_supply_read_gates').run();
it('persists baseline, interval alerts, selected scope and history through later independent reads', async () => {
  const first = await POST(post());
  expect(first.status).toBe(200);
  const a = (await first.json()) as { scopeId: string; item: SupplyHistoryRow };
  expect(a.item.document.alerts).toEqual([]);
  await unlock();
  mocks.observe.mockResolvedValueOnce(supplyFixture(1));
  const second = await POST(post());
  expect(second.status).toBe(200);
  const read = await GET(get());
  expect(read.status).toBe(200);
  const page = (await read.json()) as {
    items: SupplyHistoryRow[];
    scopeId: string;
    scopes: unknown[];
  };
  expect(page.items).toHaveLength(2);
  expect(page.scopeId).toBe(a.scopeId);
  expect(page.items[0].document.alerts).toHaveLength(2);
  expect(page.items[0].document.previousSequence).toBe(a.item.sequence);
  expect(read.headers.get('cache-control')).toBe('no-store');
  if (process.env.SUPPLY_HISTORY_QA_EXPORT)
    writeFileSync(
      process.env.SUPPLY_HISTORY_QA_EXPORT,
      JSON.stringify({
        ...page,
        id: supplyProject,
        revision: 1,
        nextCursor: null,
      }),
    );
});
it('authenticates and isolates owners, archives retain history but prohibit new captures', async () => {
  await POST(post());
  mocks.user = null;
  expect((await GET(get())).status).toBe(401);
  expect((await POST(post())).status).toBe(401);
  mocks.user = { userId: 'two' };
  expect((await GET(get())).status).toBe(404);
  expect((await POST(post())).status).toBe(404);
  mocks.user = { userId: 'one' };
  await mocks.db.prepare('UPDATE imported_token_projects SET archived=1').run();
  expect((await GET(get())).status).toBe(200);
  expect((await POST(post())).status).toBe(409);
});
it('new classifications create an independent baseline without historical ownership reinterpretation', async () => {
  await POST(post());
  await unlock();
  const changed = supplyScope.wallets.map((w) => ({
    ...w,
    group: 'pool' as const,
  }));
  mocks.observe.mockResolvedValueOnce(
    supplyFixture(1, { ...supplyScope, wallets: changed }),
  );
  const response = await POST(post(changed));
  expect(response.status).toBe(200);
  const data = (await response.json()) as {
    scopeId: string;
    item: SupplyHistoryRow;
  };
  expect(data.item.document.alerts).toEqual([]);
  const page = (await (await GET(get())).json()) as {
    scopes: unknown[];
    items: SupplyHistoryRow[];
  };
  expect(page.scopes).toHaveLength(2);
  expect(page.items).toHaveLength(1);
});
it('rejects foreign wallets, duplicates, stale revisions and bad input before RPC; enforces read pacing', async () => {
  expect(
    (await POST(post([{ address: supplyWallet(4), group: 'team' }]))).status,
  ).toBe(409);
  expect(
    (await POST(post([supplyScope.wallets[0], supplyScope.wallets[0]]))).status,
  ).toBe(400);
  await mocks.db.prepare('UPDATE imported_token_projects SET revision=2').run();
  expect((await POST(post())).status).toBe(409);
  expect(mocks.observe).not.toHaveBeenCalled();
  await mocks.db.prepare('UPDATE imported_token_projects SET revision=1').run();
  expect((await POST(post())).status).toBe(200);
  expect((await POST(post())).status).toBe(429);
  expect(mocks.observe).toHaveBeenCalledTimes(1);
});
it('refuses a watched wallet archived after saving and does not read the provider', async () => {
  await mocks.db
    .prepare('UPDATE workspace_wallets SET archived=1 WHERE address=?')
    .bind(supplyScope.wallets[1].address)
    .run();
  expect((await POST(post())).status).toBe(409);
  expect(mocks.observe).not.toHaveBeenCalled();
});
it.each(['project', 'wallet'])(
  'atomically rejects %s changes after the provider read',
  async (kind) => {
    mocks.observe.mockImplementationOnce(async () => {
      await mocks.db
        .prepare(
          kind === 'project'
            ? 'UPDATE imported_token_projects SET revision=2'
            : 'UPDATE workspace_wallets SET archived=1',
        )
        .run();
      return supplyFixture();
    });
    expect((await POST(post())).status).toBe(409);
    const count = await mocks.db
      .prepare('SELECT COUNT(*) AS count FROM imported_supply_observations')
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  },
);
it('rejects a concurrent history append without duplicating alerts', async () => {
  const first = (await (await POST(post())).json()) as {
    item: SupplyHistoryRow;
    scopeId: string;
  };
  await unlock();
  mocks.observe.mockImplementationOnce(async () => {
    const doc = captureSupply(supplyFixture(1), supplyScope, 1, first.item);
    await mocks.db
      .prepare(
        'INSERT INTO imported_supply_observations(id,owner_id,project_id,scope_id,document,created_at) VALUES(?,?,?,?,?,?)',
      )
      .bind(
        'concurrent',
        'one',
        supplyProject,
        first.scopeId,
        JSON.stringify(doc),
        doc.snapshot.observedAt,
      )
      .run();
    return supplyFixture(1);
  });
  expect((await POST(post())).status).toBe(409);
  const page = (await (await GET(get())).json()) as {
    items: SupplyHistoryRow[];
  };
  expect(page.items).toHaveLength(2);
});
it('enforces immutable captures and validates pagination cursor scope', async () => {
  const first = (await (await POST(post())).json()) as {
    item: SupplyHistoryRow;
    scopeId: string;
  };
  await expect(
    mocks.db
      .prepare('UPDATE imported_supply_observations SET document=?')
      .bind('{}')
      .run(),
  ).rejects.toThrow();
  await expect(
    mocks.db.prepare('DELETE FROM imported_supply_observations').run(),
  ).rejects.toThrow();
  expect((await GET(get(`&scope=${first.scopeId}&cursor=999`))).status).toBe(
    400,
  );
  expect((await GET(get(`&scope=${'a'.repeat(64)}`))).status).toBe(404);
  expect((await GET(get('&revision=1'))).status).toBe(400);
});
it('serves nonoverlapping older pages and preserves scope boundaries', async () => {
  const scopeId = await supplyScopeId(supplyScope);
  await mocks.db
    .prepare('INSERT INTO imported_supply_scopes VALUES(?,?,?,?,?)')
    .bind(
      'one',
      supplyProject,
      scopeId,
      JSON.stringify(supplyScope),
      '2026-10-11',
    )
    .run();
  const document = captureSupply(supplyFixture(), supplyScope, 1, null);
  for (let i = 0; i < 52; i++)
    await mocks.db
      .prepare(
        'INSERT INTO imported_supply_observations(id,owner_id,project_id,scope_id,document,created_at) VALUES(?,?,?,?,?,?)',
      )
      .bind(
        'page-' + i,
        'one',
        supplyProject,
        scopeId,
        JSON.stringify(document),
        '2026-10-11',
      )
      .run();
  const page = (await (await GET(get())).json()) as {
    items: SupplyHistoryRow[];
    nextCursor: number;
  };
  expect(page.items).toHaveLength(50);
  const older = (await (
    await GET(get(`&scope=${scopeId}&cursor=${page.nextCursor}`))
  ).json()) as { items: SupplyHistoryRow[]; nextCursor: number | null };
  expect(older.items).toHaveLength(2);
  expect(older.nextCursor).toBeNull();
  expect(older.items[0].sequence).toBeLessThan(page.items.at(-1)!.sequence);
});
