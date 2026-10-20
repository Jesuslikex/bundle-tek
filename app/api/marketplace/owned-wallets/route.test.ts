import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  expect,
  it,
  vi,
} from 'vitest';
import { Miniflare } from 'miniflare';
import bs58 from 'bs58';
import { marketplaceOwnedFixture } from '@/test/marketplace-owned-fixture';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET } from './route';
let mf: Miniflare,
  db: D1Database,
  queries: string[],
  fixture: ReturnType<typeof marketplaceOwnedFixture>;
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'marketplace-owned-api',
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
          env: { DB: { type: 'd1', id: 'marketplace-owned-api' } },
        },
      },
    ],
  });
  db = (await mf.getD1Database(
    'DB',
    'marketplace-owned-api',
  )) as unknown as D1Database;
  for (const sql of [
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,label TEXT,revision INTEGER,updated_at TEXT,archived INTEGER)',
    'CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT,verified_at TEXT)',
    'CREATE TABLE warmup_history_runs(owner_id TEXT,id TEXT,revision INTEGER,created_at TEXT,updated_at TEXT,document TEXT)',
    'CREATE TABLE warmup_buy_receipts(owner_id TEXT,wallet_address TEXT,signature TEXT)',
    'CREATE TABLE warmup_sell_receipts(owner_id TEXT,signature TEXT,document TEXT)',
  ])
    await db.prepare(sql).run();
});
afterAll(async () => mf?.dispose());
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  for (const table of [
    'workspace_wallets',
    'wallet_ownership_proofs',
    'warmup_history_runs',
    'warmup_buy_receipts',
    'warmup_sell_receipts',
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
  fixture = marketplaceOwnedFixture();
  for (const value of fixture.sources.wallets) {
    const w = value as {
      address: string;
      label: string;
      revision: number;
      updatedAt: string;
    };
    await db
      .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?,?,?)')
      .bind('one', 'Solana', w.address, w.label, w.revision, w.updatedAt, 0)
      .run();
  }
  const p = fixture.sources.proofs[0] as {
      address: string;
      verifiedAt: string;
    },
    r = fixture.sources.runs[0] as {
      id: string;
      revision: number;
      createdAt: string;
      updatedAt: string;
      document: string;
    };
  await db
    .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?,?)')
    .bind('one', 'Solana', p.address, p.verifiedAt)
    .run();
  await db
    .prepare('INSERT INTO warmup_history_runs VALUES(?,?,?,?,?,?)')
    .bind('one', r.id, r.revision, r.createdAt, r.updatedAt, r.document)
    .run();
  await db
    .prepare('INSERT INTO warmup_buy_receipts VALUES(?,?,?)')
    .bind('one', fixture.a, 'one-signature')
    .run();
  await db
    .prepare('INSERT INTO warmup_sell_receipts VALUES(?,?,?)')
    .bind('one', 'two-signature', JSON.stringify({ wallet: fixture.a }))
    .run();
  queries = [];
  mocks.user = { userId: 'one' };
  mocks.db = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          queries.push(sql);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No provider request is allowed.');
    }),
  );
});
const read = (query = '', signal?: AbortSignal) =>
  GET(
    new Request('http://localhost/api/marketplace/owned-wallets' + query, {
      signal,
    }),
  );
it('requires authentication before SQL', async () => {
  mocks.user = null;
  expect((await read()).status).toBe(401);
  expect(queries).toEqual([]);
});
it('accepts no arbitrary filters or owner selection', async () => {
  expect((await read('?owner=two')).status).toBe(400);
  expect(queries).toEqual([]);
});
it('returns a single read-only snapshot with distinct history and warmup counts and no authority', async () => {
  const response = await read(),
    body = (await response.json()) as {
      wallets: Array<Record<string, unknown>>;
    };
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(body.wallets).toHaveLength(2);
  expect(body.wallets[0]).toMatchObject({
    address: fixture.a,
    warmupReceiptCount: 2,
    warmupUniqueSignatures: 2,
    latestHistory: { balanceLamports: '1234567891' },
  });
  expect(body).toMatchObject({
    listingEnabled: false,
    purchaseEnabled: false,
    deliveryEnabled: false,
  });
  expect(queries).toHaveLength(4);
  expect(queries.every((q) => q.startsWith('SELECT'))).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it('excludes other owners, archived wallets and EVM wallets', async () => {
  await db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?,?,?)')
    .bind('two', 'Solana', fixture.a, 'Other owner', 2, fixture.date(1000), 0)
    .run();
  await db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?,?,?)')
    .bind(
      'one',
      'Solana',
      bs58.encode(new Uint8Array(32).fill(3)),
      'Archived',
      1,
      fixture.date(1000),
      1,
    )
    .run();
  await db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?,?,?)')
    .bind(
      'one',
      'Base',
      '0x' + '1'.repeat(40),
      'Base wallet',
      1,
      fixture.date(1000),
      0,
    )
    .run();
  await db
    .prepare('INSERT INTO warmup_buy_receipts VALUES(?,?,?)')
    .bind('two', fixture.a, 'private-other-receipt')
    .run();
  const body = await (await read()).json();
  expect(JSON.stringify(body)).not.toMatch(
    /Other owner|Archived|Base wallet|private-other-receipt/,
  );
  mocks.user = { userId: 'two' };
  const other = (await (await read()).json()) as {
    wallets: Array<Record<string, unknown>>;
  };
  expect(other.wallets).toHaveLength(1);
  expect(other.wallets[0]).toMatchObject({
    label: 'Other owner',
    ownershipProofAt: null,
    latestHistory: null,
    warmupReceiptCount: 1,
  });
});
it('distinguishes a genuinely empty inventory from failed storage', async () => {
  mocks.user = { userId: 'empty' };
  const response = await read();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ wallets: [] });
});
it('does not double-count one signature reused across saved receipt tables', async () => {
  await db
    .prepare('INSERT INTO warmup_sell_receipts VALUES(?,?,?)')
    .bind('one', 'one-signature', JSON.stringify({ wallet: fixture.a }))
    .run();
  const body = (await (await read()).json()) as {
    wallets: Array<Record<string, unknown>>;
  };
  expect(body.wallets[0]).toMatchObject({
    warmupReceiptCount: 3,
    warmupUniqueSignatures: 2,
  });
});
it('refuses corrupted saved history without exposing SQL or raw provider details', async () => {
  await db
    .prepare(
      "UPDATE warmup_history_runs SET document='invalid-private-provider-key'",
    )
    .run();
  const response = await read();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toMatch(
    /invalid-private|JSON|SQLITE|parser/,
  );
});
it('withholds the entire result when the owned wallet limit would truncate evidence', async () => {
  const writes = [];
  for (let n = 3; n <= 501; n++) {
    const bytes = new Uint8Array(32);
    new DataView(bytes.buffer).setUint32(0, n);
    writes.push(
      db
        .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?,?,?)')
        .bind(
          'one',
          'Solana',
          bs58.encode(bytes),
          'Extra',
          1,
          fixture.date(1000),
          0,
        ),
    );
  }
  await db.batch(writes);
  expect((await read()).status).toBe(503);
});
it('does not perform storage or provider work after cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  expect((await read('', controller.signal)).status).toBe(408);
  expect(queries).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});
