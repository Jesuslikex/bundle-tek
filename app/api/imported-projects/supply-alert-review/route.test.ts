import { beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
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
  accounts: vi.fn(),
}));
vi.mock('@/lib/supply-token-accounts', () => ({
  observeSupplyTokenAccounts: mocks.accounts,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/supply-movement-evidence', async (original) => ({
  ...(await original<typeof import('@/lib/supply-movement-evidence')>()),
  observeSupplyMovementEvidence: mocks.observe,
}));
import { GET, POST } from './route';
let mf: Miniflare;
let current: SupplyHistoryRow;
const wallet = supplyScope.wallets[0].address;
const migration = [
  '0063_imported_supply_history',
  '0064_supply_movement_evidence',
  '0065_supply_alert_reviews',
].flatMap((name) =>
  readFileSync(`drizzle/${name}.sql`, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean),
);
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'movement-tests',
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
          env: { DB: { type: 'd1', id: 'movement-test-only' } },
        },
      },
    ],
  });
  mocks.db = await mf.getD1Database('DB', 'movement-tests');
  await mocks.db
    .prepare(
      'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,revision INTEGER)',
    )
    .run();
});
afterAll(async () => mf?.dispose());
beforeEach(async () => {
  mocks.user = { userId: 'one' };
  mocks.observe.mockReset();
  mocks.accounts.mockReset().mockResolvedValue({
    wallet,
    mint: supplyScope.mint,
    decimals: 6,
    slot: 200,
    accounts: [supplyWallet(5)],
    source: 'fixture.test',
    observedAt: new Date().toISOString(),
  });
  for (const table of [
    'supply_alert_reviews',
    'supply_movement_evidence',
    'imported_supply_observations',
    'imported_supply_scopes',
    'imported_supply_read_gates',
  ])
    await mocks.db.prepare('DROP TABLE IF EXISTS ' + table).run();
  for (const statement of migration) await mocks.db.prepare(statement).run();
  await mocks.db.prepare('DELETE FROM imported_token_projects').run();
  await mocks.db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,1)')
    .bind('one', supplyProject)
    .run();
  const scopeId = await supplyScopeId(supplyScope);
  const previous: SupplyHistoryRow = {
    id: 'first',
    sequence: 1,
    scopeId,
    document: captureSupply(supplyFixture(), supplyScope, 1, null),
  };
  current = {
    id: 'second',
    sequence: 2,
    scopeId,
    document: captureSupply(supplyFixture(1), supplyScope, 1, previous),
  };
  await mocks.db
    .prepare(
      'INSERT INTO imported_supply_scopes(owner_id,project_id,id,document,created_at) VALUES(?,?,?,?,?)',
    )
    .bind(
      'one',
      supplyProject,
      scopeId,
      JSON.stringify(supplyScope),
      new Date().toISOString(),
    )
    .run();
  for (const row of [previous, current])
    await mocks.db
      .prepare(
        'INSERT INTO imported_supply_observations(sequence,id,owner_id,project_id,scope_id,document,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .bind(
        row.sequence,
        row.id,
        'one',
        supplyProject,
        scopeId,
        JSON.stringify(row.document),
        new Date().toISOString(),
      )
      .run();
  mocks.observe.mockResolvedValue({
    observationId: current.id,
    wallet,
    mint: supplyScope.mint,
    fromSlot: 101,
    toSlot: 141,
    anchor: 200,
    requestedCursor: null,
    nextCursor: null,
    scannedSignatures: 0,
    failedSignatures: 0,
    unavailableTransactions: 0,
    completeThroughBoundary: true,
    transactions: [],
    observedAt: new Date().toISOString(),
  });
});
const terms = () => ({
  id: supplyProject,
  revision: 1,
  scope: current.scopeId,
});
const get = (extra = {}) =>
  new Request(
    'http://localhost/api/imported-projects/supply-alert-review?' +
      new URLSearchParams({ ...terms(), revision: '1', ...extra }),
  );
const post = (sequence = 2, extra = {}) =>
  new Request('http://localhost/api/imported-projects/supply-alert-review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...terms(), sequence, ...extra }),
  });
it('persists scoped review markers and reloads/reset without modifying observations', async () => {
  expect(
    ((await (await GET(get())).json()) as { reviewedThrough: number })
      .reviewedThrough,
  ).toBe(0);
  expect((await POST(post())).status).toBe(200);
  expect(
    ((await (await GET(get())).json()) as { reviewedThrough: number })
      .reviewedThrough,
  ).toBe(2);
  expect((await POST(post(1))).status).toBe(200);
  expect(
    ((await (await GET(get())).json()) as { reviewedThrough: number })
      .reviewedThrough,
  ).toBe(2);
  expect((await POST(post(0))).status).toBe(200);
  expect(
    ((await (await GET(get())).json()) as { reviewedThrough: number })
      .reviewedThrough,
  ).toBe(0);
  expect(
    (
      await mocks.db
        .prepare('SELECT COUNT(*) AS n FROM imported_supply_observations')
        .first<{ n: number }>()
    )?.n,
  ).toBe(2);
});
it('rejects unowned scopes, invalid observations, stale revisions and unsigned requests', async () => {
  expect((await POST(post(999))).status).toBe(400);
  expect((await POST(post(2, { scope: 'a'.repeat(64) }))).status).toBe(404);
  expect((await POST(post(2, { revision: 2 }))).status).toBe(409);
  mocks.user = { userId: 'other' };
  expect((await GET(get())).status).toBe(404);
  expect((await POST(post())).status).toBe(404);
  mocks.user = null;
  expect((await GET(get())).status).toBe(401);
});
it('rejects cross-origin review writes and malformed context', async () => {
  const request = post();
  request.headers.set('origin', 'https://other.test');
  expect((await POST(request)).status).toBe(403);
  expect((await POST(post(-1))).status).toBe(400);
  expect((await GET(get({ scope: 'bad' }))).status).toBe(400);
});

it('rejects a project revision change between admission and the atomic review write', async () => {
  const db = mocks.db;
  mocks.db = {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      if (!sql.startsWith('INSERT INTO supply_alert_reviews')) return statement;
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            async run() {
              await db
                .prepare('UPDATE imported_token_projects SET revision=2')
                .run();
              return bound.run();
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  try {
    expect((await POST(post())).status).toBe(409);
    expect(
      (
        await db
          .prepare('SELECT COUNT(*) AS n FROM supply_alert_reviews')
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  } finally {
    mocks.db = db;
  }
});
it('retains immutable observations and scopes when review state changes', async () => {
  await POST(post());
  await expect(
    mocks.db
      .prepare('DELETE FROM imported_supply_observations WHERE sequence=2')
      .run(),
  ).rejects.toThrow();
  await expect(
    mocks.db
      .prepare('UPDATE imported_supply_scopes SET document=?')
      .bind('{}')
      .run(),
  ).rejects.toThrow();
  expect(
    (await (await GET(get())).json()) as { reviewedThrough: number },
  ).toMatchObject({ reviewedThrough: 2 });
});
