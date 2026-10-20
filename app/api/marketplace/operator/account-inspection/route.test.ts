import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '@/db/turso';
import { marketplaceOwnedFixture } from '@/test/marketplace-owned-fixture';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
const mocks = vi.hoisted(() => ({
  user: { userId: 'operator' } as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/wallet-rpc-pacing', () => ({ paceWalletRpc: async () => {} }));
import { POST } from './route';
let client: Client,
  db: D1Database,
  fixture: ReturnType<typeof marketplaceOwnedFixture>,
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let methods: string[], afterAccount: (() => Promise<void>) | undefined;
beforeEach(async () => {
  client = createClient({ url: 'file::memory:', intMode: 'number' });
  db = createTursoDatabase(client);
  mocks.db = db;
  for (const sql of [
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,label TEXT,revision INTEGER,updated_at TEXT,archived INTEGER)',
    'CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT,verified_at TEXT)',
    'CREATE TABLE warmup_history_runs(owner_id TEXT,id TEXT,revision INTEGER,created_at TEXT,updated_at TEXT,document TEXT)',
    'CREATE TABLE warmup_buy_receipts(owner_id TEXT,wallet_address TEXT,signature TEXT)',
    'CREATE TABLE warmup_sell_receipts(owner_id TEXT,signature TEXT,document TEXT)',
    'CREATE TABLE market_read_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER NOT NULL)',
  ])
    await db.prepare(sql).run();
  fixture = marketplaceOwnedFixture();
  await db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?,?,?)')
    .bind('operator', 'Solana', fixture.a, 'A', 2, fixture.date(3600000), 0)
    .run();
  await db
    .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?,?)')
    .bind('operator', 'Solana', fixture.a, fixture.date(60000))
    .run();
  mocks.user = { userId: 'operator' };
  vi.stubEnv('MARKETPLACE_OPERATOR_USER_IDS', '["operator"]');
  methods = [];
  afterAccount = undefined;
  fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw Error('Expected RPC body');
    const body = JSON.parse(init.body);
    methods.push(body.method);
    let result: unknown;
    if (body.method === 'getGenesisHash') result = SOLANA_MAINNET_GENESIS;
    else if (body.method === 'getSlot')
      result = methods.length === 2 ? 100 : 102;
    else if (body.method === 'getAccountInfo') {
      expect(body.params[0]).toBe(fixture.a);
      result = {
        context: { slot: 101 },
        value: {
          owner: '11111111111111111111111111111111',
          lamports: 1234567891,
          space: 0,
          executable: false,
          data: ['', 'base64'],
        },
      };
      await afterAccount?.();
    } else throw Error('Unexpected RPC method');
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  client.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function request(
  body: unknown = {
    address: fixture.a,
    walletRevision: 2,
    priceLamports: '50000000',
  },
  headers: Record<string, string> = {
    origin: 'http://localhost',
    'content-type': 'application/json',
  },
  signal?: AbortSignal,
  query = '',
) {
  return POST(
    new Request(
      'http://localhost/api/marketplace/operator/account-inspection' + query,
      {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal,
      },
    ),
  );
}
async function gates() {
  return (await db
    .prepare('SELECT count(*) AS n FROM market_read_gates')
    .first<{ n: number }>())!.n;
}
it('authenticates and checks server operator configuration before pacing, SQL inventory or providers', async () => {
  mocks.user = null;
  expect((await request()).status).toBe(401);
  mocks.user = { userId: 'buyer' };
  expect((await request()).status).toBe(403);
  mocks.user = { userId: 'operator' };
  vi.stubEnv('MARKETPLACE_OPERATOR_USER_IDS', '*');
  expect((await request()).status).toBe(403);
  expect(await gates()).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
});
it('rejects wrong origins, query selectors, non-JSON, oversized bodies and caller claims before pacing or RPC', async () => {
  expect((await request({}, {})).status).toBe(403);
  expect(
    (
      await request(
        {},
        { origin: 'http://localhost', 'content-type': 'text/plain' },
      )
    ).status,
  ).toBe(415);
  expect(
    (await request({}, undefined, undefined, '?owner=operator')).status,
  ).toBe(400);
  expect(
    (
      await request({
        address: fixture.a,
        walletRevision: 2,
        priceLamports: '1',
        ownerId: 'operator',
      })
    ).status,
  ).toBe(400);
  expect(
    (await request(JSON.stringify({ padding: 'ü'.repeat(1100) }))).status,
  ).toBe(413);
  expect(await gates()).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
});
it('runs the real owned SQL reader and RPC collector, exposing no financial authority and only a pacing write', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({
    inspection: {
      selection: { address: fixture.a, walletRevision: 2 },
      account: { kind: 'system-wallet', balanceLamports: '1234567891' },
      historicalBalanceLamports: null,
      saleQualified: false,
      signingAllowed: false,
      paymentAllowed: false,
      deliveryAllowed: false,
    },
  });
  expect(methods).toEqual([
    'getGenesisHash',
    'getSlot',
    'getAccountInfo',
    'getSlot',
  ]);
  expect(await gates()).toBe(1);
  const row = await db
    .prepare('SELECT owner_id AS key FROM market_read_gates')
    .first<{ key: string }>();
  expect(row?.key).toMatch(/^marketplace-sale-inspection:[a-f0-9]{64}$/);
  expect(
    (
      await db
        .prepare('SELECT revision FROM workspace_wallets')
        .first<{ revision: number }>()
    )?.revision,
  ).toBe(2);
});
it('isolates the inspection cooldown and admits only one concurrent request', async () => {
  await db
    .prepare('INSERT INTO market_read_gates VALUES(?,?)')
    .bind('operator', Date.now() + 999999)
    .run();
  const responses = await Promise.all([request(), request()]);
  expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
    200, 429,
  ]);
  expect(methods).toHaveLength(4);
  expect(
    responses.find((r) => r.status === 429)?.headers.get('retry-after'),
  ).toBe('15');
});
it('rejects a foreign wallet revision before RPC and maps source drift after RPC to 409', async () => {
  expect(
    (
      await request({
        address: fixture.b,
        walletRevision: 1,
        priceLamports: '1',
      })
    ).status,
  ).toBe(409);
  expect(fetcher).not.toHaveBeenCalled();
  await db.prepare('DELETE FROM market_read_gates').run();
  afterAccount = async () => {
    await db
      .prepare('UPDATE workspace_wallets SET revision=3 WHERE owner_id=?')
      .bind('operator')
      .run();
  };
  expect((await request()).status).toBe(409);
});
it.each(['operator', 'session'])(
  'rechecks %s access after RPC and withholds the result on revocation',
  async (change) => {
    afterAccount = async () => {
      if (change === 'operator')
        vi.stubEnv('MARKETPLACE_OPERATOR_USER_IDS', '[]');
      else mocks.user = { userId: 'other' };
    };
    expect((await request()).status).toBe(403);
  },
);
it('returns sanitized 429 on provider throttling without retry', async () => {
  fetcher.mockResolvedValueOnce(
    new Response('private provider URL', { status: 429 }),
  );
  const response = await request();
  expect(response.status).toBe(429);
  expect(await response.text()).not.toContain('private provider');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('refuses cancellation before SQL and during RPC', async () => {
  const stopped = new AbortController();
  stopped.abort();
  expect((await request(undefined, undefined, stopped.signal)).status).toBe(
    408,
  );
  expect(await gates()).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
  const pending = new AbortController();
  afterAccount = async () => {
    pending.abort();
  };
  expect((await request(undefined, undefined, pending.signal)).status).toBe(
    408,
  );
});
it('refuses missing pacing schema and hides raw provider, parser and storage errors', async () => {
  await db.prepare('DROP TABLE market_read_gates').run();
  const response = await request();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('market_read_gates');
  expect(fetcher).not.toHaveBeenCalled();
});
