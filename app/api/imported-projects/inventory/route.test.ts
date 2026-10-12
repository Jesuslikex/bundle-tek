import { beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { mkdirSync, writeFileSync } from 'node:fs';
import { inventoryFixture } from '../../../../test/imported-wallet-inventory-fixture';
import {
  acquisitionId as id,
  acquisitionWallet as wallet,
  acquisitionMint as mint,
} from '../../../../test/imported-sell-acquisition-fixture';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET } from './route';
let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'inventory-tests',
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
          env: { DB: { type: 'd1', id: 'inventory-test-only' } },
        },
      },
    ],
  });
  mocks.db = await mf.getD1Database('DB', 'inventory-tests');
  for (const sql of [
    'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,revision INTEGER,chain TEXT,archived INTEGER,document TEXT)',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
    'CREATE TABLE wallet_holdings_snapshots(owner_id TEXT,chain TEXT,address TEXT,document TEXT)',
  ])
    await mocks.db.prepare(sql).run();
});
afterAll(async () => mf?.dispose());
beforeEach(async () => {
  mocks.user = { userId: 'one' };
  for (const table of [
    'imported_token_projects',
    'workspace_wallets',
    'wallet_holdings_snapshots',
  ])
    await mocks.db.prepare('DELETE FROM ' + table).run();
  await mocks.db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,1,?,0,?)')
    .bind(
      'one',
      id(1),
      'Solana',
      JSON.stringify({
        token: { chain: 'Solana', address: mint, decimals: 6 },
      }),
    )
    .run();
  await mocks.db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,1,0)')
    .bind('one', 'Solana', wallet)
    .run();
});
const request = (query = `id=${id(1)}&revision=1`) =>
  new Request('http://localhost/api/imported-projects/inventory?' + query);
it('authenticates and rejects unknown parameters, stale or foreign projects', async () => {
  mocks.user = null;
  expect((await GET(request())).status).toBe(401);
  mocks.user = { userId: 'two' };
  expect((await GET(request())).status).toBe(409);
  mocks.user = { userId: 'one' };
  for (const query of [
    `id=${id(1)}&revision=2`,
    `id=${id(1)}&revision=1&extra=1`,
    `id=${id(1)}&revision=1&revision=1`,
  ])
    expect([400, 409]).toContain((await GET(request(query))).status);
});
it('reads exact saved inventory with owner and active-network isolation without provider access', async () => {
  await mocks.db
    .prepare('INSERT INTO wallet_holdings_snapshots VALUES(?,?,?,?)')
    .bind('one', 'Solana', wallet, JSON.stringify(inventoryFixture()))
    .run();
  for (const values of [
    ['two', 'Solana', 'foreign', 1, 0],
    ['one', 'Solana', 'archived', 1, 1],
    ['one', 'Base', 'evm', 1, 0],
    ['one', 'Solana', '11111111111111111111111111111111', 2, 0],
  ])
    await mocks.db
      .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?)')
      .bind(...values)
      .run();
  const response = await GET(request());
  expect(response.status).toBe(200);
  const result = (await response.json()) as {
    items: Array<{ wallet: string; observation: unknown }>;
  };
  expect(result.items).toHaveLength(2);
  expect(
    result.items.find((i) => i.wallet === wallet)?.observation,
  ).toMatchObject({
    raw: '4003',
    unfrozenRaw: '3003',
    frozenRaw: '1000',
    amount: '0.004003',
  });
  expect(result.items.find((i) => i.wallet !== wallet)?.observation).toBeNull();
  mkdirSync('work/imported-sell-presets-qa', { recursive: true });
  writeFileSync(
    'work/imported-sell-presets-qa/inventory.json',
    JSON.stringify(result, null, 2),
  );
});
it('withholds all observations on damaged coverage and bounds complete roster size', async () => {
  const snapshot = inventoryFixture();
  snapshot.accountCount = 3;
  await mocks.db
    .prepare('INSERT INTO wallet_holdings_snapshots VALUES(?,?,?,?)')
    .bind('one', 'Solana', wallet, JSON.stringify(snapshot))
    .run();
  const response = await GET(request());
  expect(response.status).toBe(503);
  expect(await response.json()).not.toHaveProperty('items');
  await mocks.db.prepare('DELETE FROM wallet_holdings_snapshots').run();
  await mocks.db
    .prepare(
      "WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<499) INSERT INTO workspace_wallets SELECT 'one','Solana','public-'||x,1,0 FROM n",
    )
    .run();
  expect((await GET(request())).status).toBe(503);
});
it('rejects oversized aggregate saved snapshots before returning their documents', async () => {
  await mocks.db
    .prepare(
      "WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<4) INSERT INTO workspace_wallets SELECT 'one','Solana','public-'||x,1,0 FROM n",
    )
    .run();
  await mocks.db
    .prepare(
      "WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<4) INSERT INTO wallet_holdings_snapshots SELECT 'one','Solana','public-'||x,json_set(?,'$.address','public-'||x,'$.padding',hex(zeroblob(900000))) FROM n",
    )
    .bind(JSON.stringify(inventoryFixture()))
    .run();
  const response = await GET(request());
  expect(response.status).toBe(503);
  expect(await response.json()).not.toHaveProperty('items');
}, 20000);
