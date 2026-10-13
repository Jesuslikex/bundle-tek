import { beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { conditionalLevelReviews } from '@/lib/conditional-level-review';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { GET, POST } from './route';
import { POST as prepareSwap } from '../prepare/route';
import type { ConditionalSellOrder } from '../../../../lib/conditional-sell-order';
import {
  captureConditionalPreparation,
  conditionalLevelRequest,
} from '../../../../lib/conditional-preparation-server';
import { saveSwapPreparation } from '../../../../lib/imported-swap-preparation-history';
import { reserveImportedApproval } from '../../../../lib/imported-swap-approval';
import { preparationHistoryFixture } from '../../../../test/imported-preparation-history-fixture';
type Page = { orders: ConditionalSellOrder[]; executionAllowed: false };
type Result = {
  order: ConditionalSellOrder;
  executionAllowed: false;
  reviews: { met: boolean }[];
};
let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'conditional-orders-tests',
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
          env: { DB: { type: 'd1', id: 'conditional-orders-test-only' } },
        },
      },
    ],
  });
  mocks.db = await mf.getD1Database('DB', 'conditional-orders-tests');
  for (const sql of [
    'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,revision INTEGER,chain TEXT,address TEXT,archived INTEGER,document TEXT)',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
    'CREATE TABLE imported_market_observations(owner_id TEXT,project_id TEXT,document TEXT)',
    'CREATE TABLE conditional_level_reservations(owner_id TEXT,order_id TEXT,level INTEGER,intent_id TEXT,units_raw TEXT,created_at TEXT)',
    'CREATE TABLE conditional_level_fills(owner_id TEXT,order_id TEXT,level INTEGER,intent_id TEXT,units_raw TEXT,signature TEXT,receipt_id TEXT)',
    'CREATE TABLE imported_swap_signing_intents(owner_id TEXT,id TEXT,state TEXT,signature TEXT)',
    'CREATE TABLE imported_swap_preparations(id TEXT,owner_id TEXT,project_id TEXT,project_revision INTEGER,wallet_address TEXT,wallet_revision INTEGER,document TEXT,created_at TEXT)',
    ...readFileSync('drizzle/0056_conditional_sell_orders.sql', 'utf8').split(
      '--> statement-breakpoint',
    ),
  ])
    await mocks.db.prepare(sql).run();
});
afterAll(async () => mf?.dispose());
beforeEach(async () => {
  mocks.user = { userId: 'one' };
  for (const table of [
    'conditional_sell_orders',
    'conditional_level_reservations',
    'conditional_level_fills',
    'imported_token_projects',
    'workspace_wallets',
    'imported_market_observations',
    'imported_swap_preparations',
  ])
    await mocks.db.prepare('DELETE FROM ' + table).run();
  await mocks.db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,1,?,?,0,?)')
    .bind(
      'one',
      id(1),
      'Solana',
      mint,
      JSON.stringify({
        token: { chain: 'Solana', address: mint, decimals: 6 },
      }),
    )
    .run();
  await mocks.db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,1,0)')
    .bind('one', 'Solana', wallet)
    .run();
  await market();
});

const levelRequest = { orderId: id(2), revision: 1, level: 1 };
const levelContext = {
  projectId: id(1),
  projectRevision: 1,
  wallet,
  walletRevision: 1,
  mint,
  decimals: 6,
  side: 'Sell',
  unitsRaw: '2',
};
it('captures only the exact owned, fresh, met saved level and rejects alternate trade context', async () => {
  await post(terms());
  const guard = await captureConditionalPreparation(
    mocks.db,
    'one',
    levelRequest,
    levelContext,
  );
  expect(guard.selection.targetUsd).toBe('4064');
  expect(guard.selection.termsSha256).toMatch(/^[a-f0-9]{64}$/);
  for (const changes of [
    { side: 'Buy' },
    { unitsRaw: '13' },
    { decimals: 9 },
    { walletRevision: 2 },
    { projectRevision: 2 },
  ])
    await expect(
      captureConditionalPreparation(mocks.db, 'one', levelRequest, {
        ...levelContext,
        ...changes,
      }),
    ).rejects.toThrow();
  await expect(
    captureConditionalPreparation(
      mocks.db,
      'other',
      levelRequest,
      levelContext,
    ),
  ).rejects.toThrow();
  await expect(
    captureConditionalPreparation(
      mocks.db,
      'one',
      { ...levelRequest, level: 4 },
      levelContext,
    ),
  ).rejects.toThrow();
  await market(31000);
  await expect(
    captureConditionalPreparation(mocks.db, 'one', levelRequest, levelContext),
  ).rejects.toThrow();
  expect(() =>
    conditionalLevelRequest({ ...levelRequest, amount: '1' }),
  ).toThrow();
});
it('persists condition metadata atomically and rejects cancellation, market replacement and metadata stripping races', async () => {
  await post(terms());
  const guard = await captureConditionalPreparation(
    mocks.db,
    'one',
    levelRequest,
    levelContext,
  );
  const document = {
    ...preparationHistoryFixture(),
    wallet,
    inputMint: mint,
    inAmountRaw: '2',
    conditional: guard.selection,
  };
  const saved = await saveSwapPreparation(
    mocks.db,
    'one',
    levelContext,
    document,
    undefined,
    guard,
  );
  expect(saved?.document.conditional).toEqual(guard.selection);
  await expect(
    saveSwapPreparation(mocks.db, 'one', levelContext, document),
  ).rejects.toThrow();
  await expect(
    saveSwapPreparation(
      mocks.db,
      'one',
      levelContext,
      { ...document, inAmountRaw: '3' },
      undefined,
      guard,
    ),
  ).rejects.toThrow();
  await market();
  expect(
    await saveSwapPreparation(
      mocks.db,
      'one',
      levelContext,
      document,
      undefined,
      guard,
    ),
  ).toBeNull();
  const updated = await captureConditionalPreparation(
    mocks.db,
    'one',
    levelRequest,
    levelContext,
  );
  await operation('cancel');
  expect(
    await saveSwapPreparation(
      mocks.db,
      'one',
      levelContext,
      { ...document, conditional: updated.selection },
      undefined,
      updated,
    ),
  ).toBeNull();
});
it('blocks ordinary signing reservation from stripping a captured conditional order', async () => {
  await expect(
    reserveImportedApproval(
      mocks.db,
      'one',
      {
        id: id(3),
        document: JSON.stringify({ conditional: { orderId: id(2) } }),
      },
      {} as Parameters<typeof reserveImportedApproval>[3],
    ),
  ).rejects.toThrow('Conditional approval binding');
});

it('enforces the conditional contract in the actual preparation API before provider work', async () => {
  await post(terms());
  const prepare = (conditional: unknown, changes = {}) =>
    prepareSwap(
      new Request('http://localhost/api/imported-projects/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: id(1),
          revision: 1,
          wallet,
          walletRevision: 1,
          side: 'Sell',
          amount: '0.000002',
          conditional,
          ...changes,
        }),
      }),
    );
  expect((await prepare({ ...levelRequest, level: 4 })).status).toBe(409);
  expect((await prepare({ ...levelRequest, amount: '1' })).status).toBe(400);
  const unsupportedBuy = await prepare(levelRequest, { side: 'Buy' });
  expect(unsupportedBuy.status).toBe(503);
  expect(((await unsupportedBuy.json()) as { error: string }).error).toContain(
    'Conditional Buy storage is not upgraded',
  );
  expect((await prepare(levelRequest, { amount: '0.000013' })).status).toBe(
    409,
  );
  expect((await prepare(levelRequest)).status).toBe(503);
  await operation('cancel');
  expect((await prepare(levelRequest)).status).toBe(409);
});

it('withholds cancellation and preparation writes when a level is already reserved or filled', async () => {
  await post(terms());
  const guard = await captureConditionalPreparation(
    mocks.db,
    'one',
    levelRequest,
    levelContext,
  );
  const document = {
    ...preparationHistoryFixture(),
    wallet,
    inputMint: mint,
    inAmountRaw: '2',
    conditional: guard.selection,
  };
  await mocks.db
    .prepare('INSERT INTO conditional_level_reservations VALUES(?,?,?,?,?,?)')
    .bind('one', id(2), 1, id(3), '2', new Date().toISOString())
    .run();
  expect((await operation('cancel')).status).toBe(409);
  await expect(
    captureConditionalPreparation(mocks.db, 'one', levelRequest, levelContext),
  ).rejects.toThrow();
  expect(
    await saveSwapPreparation(
      mocks.db,
      'one',
      levelContext,
      document,
      undefined,
      guard,
    ),
  ).toBeNull();
  await mocks.db.prepare('DELETE FROM conditional_level_reservations').run();
  await mocks.db
    .prepare(
      'INSERT INTO conditional_level_fills(owner_id,order_id,level) VALUES(?,?,?)',
    )
    .bind('one', id(2), 1)
    .run();
  await expect(
    captureConditionalPreparation(mocks.db, 'one', levelRequest, levelContext),
  ).rejects.toThrow();
  expect(
    await saveSwapPreparation(
      mocks.db,
      'one',
      levelContext,
      document,
      undefined,
      guard,
    ),
  ).toBeNull();
});
const terms = () => ({
  action: 'create',
  projectId: id(1),
  orderId: id(2),
  projectRevision: 1,
  wallet,
  walletRevision: 1,
  pair: mint,
  kind: 'grid',
  direction: 'at-or-above',
  amount: '0.000013',
  minimumUsd: '4064',
  maximumUsd: '4877',
  lines: 5,
});
const post = (body: unknown, origin = 'http://localhost') =>
  POST(
    new Request('http://localhost/api/imported-projects/conditional-orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(body),
    }),
  );
const list = () =>
  GET(
    new Request(
      'http://localhost/api/imported-projects/conditional-orders?projectId=' +
        id(1),
    ),
  );
const operation = (action: string, revision = 1) =>
  post({ action, projectId: id(1), orderId: id(2), revision });
async function market(age = 0, revision = 1) {
  await mocks.db.prepare('DELETE FROM imported_market_observations').run();
  await mocks.db
    .prepare('INSERT INTO imported_market_observations VALUES(?,?,?)')
    .bind(
      'one',
      id(1),
      JSON.stringify([
        {
          chain: 'Solana',
          address: mint,
          projectRevision: revision,
          source: 'api.dexscreener.com',
          executionAllowed: false,
          observedAt: new Date(Date.now() - age).toISOString(),
          pairs: [{ address: mint, marketCapUsd: 4470.5 }],
        },
      ]),
    )
    .run();
}
it('authenticates, isolates owners and rejects extra inputs and cross-origin writes', async () => {
  mocks.user = null;
  expect((await post(terms())).status).toBe(401);
  expect((await list()).status).toBe(401);
  mocks.user = { userId: 'other' };
  expect((await post(terms())).status).toBe(404);
  expect((await list()).status).toBe(404);
  mocks.user = { userId: 'one' };
  expect((await post({ ...terms(), executionAllowed: true })).status).toBe(400);
  expect((await post(terms(), 'https://other.test')).status).toBe(400);
});
it('stores exact conserved grid terms and makes duplicate submissions idempotent', async () => {
  const responses = await Promise.all([post(terms()), post(terms())]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  const page = (await (await list()).json()) as Page;
  expect(page.orders).toHaveLength(1);
  expect(page.executionAllowed).toBe(false);
  expect(
    page.orders[0].terms.levels.map((r: { unitsRaw: string }) => r.unitsRaw),
  ).toEqual(['2', '2', '2', '2', '5']);
  expect(page.orders[0].state).toBe('draft');
  mkdirSync('work/conditional-sell-qa', { recursive: true });
  writeFileSync(
    'work/conditional-sell-qa/order-fixture.json',
    JSON.stringify(page.orders[0]),
  );
  expect((await post({ ...terms(), amount: '0.000014' })).status).toBe(409);
});
it('rejects stale or archived contexts and enforces bounded order retention', async () => {
  expect((await post({ ...terms(), walletRevision: 2 })).status).toBe(409);
  expect((await post({ ...terms(), projectRevision: 2 })).status).toBe(409);
  await mocks.db.prepare('UPDATE workspace_wallets SET archived=1').run();
  expect((await post(terms())).status).toBe(409);
  await mocks.db.prepare('UPDATE workspace_wallets SET archived=0').run();
  await mocks.db
    .prepare(
      "WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100) INSERT INTO conditional_sell_orders SELECT 'one','existing-'||x,?,'{}','cancelled',1,'time','time' FROM n",
    )
    .bind(id(1))
    .run();
  expect((await post(terms())).status).toBe(409);
  await mocks.db.prepare('UPDATE imported_token_projects SET archived=1').run();
  expect((await post(terms())).status).toBe(409);
});
it('reviews current persisted market evidence but cannot approve or execute', async () => {
  await post(terms());
  const response = await operation('review');
  expect(response.status).toBe(200);
  const data = (await response.json()) as Result;
  expect(data.executionAllowed).toBe(false);
  const saved = (await (await list()).json()) as Page;
  expect(
    conditionalLevelReviews(data, saved.orders[0]).map((r) => r.met),
  ).toEqual([true, true, true, false, false]);
  expect(data.reviews.map((r: { met: boolean }) => r.met)).toEqual([
    true,
    true,
    true,
    false,
    false,
  ]);
  await market(31000);
  expect((await operation('review')).status).toBe(422);
  await market(0, 2);
  expect((await operation('review')).status).toBe(422);
  await market();
  await mocks.db.prepare('UPDATE workspace_wallets SET revision=2').run();
  expect((await operation('review')).status).toBe(409);
});
it('cancels with revision guards even after archival, preserves terms and rejects cancelled reviews', async () => {
  await post(terms());
  const before = (await (await list()).json()) as Page;
  expect((await operation('cancel', 2)).status).toBe(409);
  await mocks.db
    .prepare('UPDATE imported_token_projects SET archived=1,revision=2')
    .run();
  const cancelled = (await (await operation('cancel')).json()) as Result;
  expect(cancelled.order.state).toBe('cancelled');
  expect(cancelled.order.revision).toBe(2);
  expect(cancelled.order.terms).toEqual(before.orders[0].terms);
  expect((await operation('cancel')).status).toBe(200);
  expect((await operation('review')).status).toBe(409);
});
it('saves exact limit terms, validates directions and denies invalid tiny grids', async () => {
  const { minimumUsd, maximumUsd, lines, ...base } = terms();
  void minimumUsd;
  void maximumUsd;
  void lines;
  const limit = {
    ...base,
    kind: 'limit',
    direction: 'at-or-below',
    targetUsd: '4064.000001',
  };
  const saved = (await (await post(limit)).json()) as Result;
  expect(saved.order.terms.levels).toHaveLength(1);
  expect(saved.order.terms.levels[0].unitsRaw).toBe('13');
  expect(
    (await post({ ...terms(), orderId: id(3), amount: '0.000004' })).status,
  ).toBe(400);
  expect((await post({ ...terms(), orderId: id(3), lines: '5' })).status).toBe(
    400,
  );
  expect(
    (await post({ ...terms(), orderId: id(3), direction: 'at-or-below' }))
      .status,
  ).toBe(400);
});

it('atomically withholds inserts when project evidence or wallet revision changes after the initial read', async () => {
  const real = mocks.db;
  for (const mutation of [
    'UPDATE workspace_wallets SET revision=2',
    "UPDATE imported_token_projects SET document=json_set(document,'$.token.decimals',7)",
  ]) {
    await real.prepare('UPDATE workspace_wallets SET revision=1').run();
    await real
      .prepare(
        "UPDATE imported_token_projects SET document=json_set(document,'$.token.decimals',6)",
      )
      .run();
    mocks.db = {
      prepare: (sql: string) => {
        const statement = real.prepare(sql);
        if (!sql.startsWith('INSERT INTO conditional_sell_orders'))
          return statement;
        return {
          bind: (...values: unknown[]) => {
            const bound = statement.bind(...values);
            return {
              run: async () => {
                await real.prepare(mutation).run();
                return bound.run();
              },
            };
          },
        } as D1PreparedStatement;
      },
    } as D1Database;
    try {
      expect((await post(terms())).status).toBe(409);
    } finally {
      mocks.db = real;
    }
    expect(
      (await real
        .prepare('SELECT COUNT(*) AS count FROM conditional_sell_orders')
        .first<{ count: number }>())!.count,
    ).toBe(0);
  }
});
