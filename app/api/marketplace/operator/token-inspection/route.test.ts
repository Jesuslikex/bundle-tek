import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '@/db/turso';
import { marketplaceTokenInspectionFixture } from '@/test/marketplace-token-inspection-fixture';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import { MARKETPLACE_TOKEN_PROGRAMS } from '@/lib/marketplace-token-inspection-view';
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
  fixture: ReturnType<typeof marketplaceTokenInspectionFixture>,
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let methods: string[],
  queries: string[],
  tokenHook: (() => Promise<void>) | undefined;
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
  fixture = marketplaceTokenInspectionFixture();
  await db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?,?,?)')
    .bind(
      'operator',
      'Solana',
      fixture.source.a,
      'A',
      2,
      fixture.source.date(3600000),
      0,
    )
    .run();
  await db
    .prepare('INSERT INTO wallet_ownership_proofs VALUES(?,?,?,?)')
    .bind('operator', 'Solana', fixture.source.a, fixture.source.date(60000))
    .run();
  queries = [];
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    queries.push(sql);
    return prepare(sql);
  });
  mocks.user = { userId: 'operator' };
  vi.stubEnv('MARKETPLACE_OPERATOR_USER_IDS', '["operator"]');
  methods = [];
  tokenHook = undefined;
  fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw Error('Expected RPC body');
    const body = JSON.parse(init.body);
    methods.push(body.method);
    let result: unknown;
    if (body.method === 'getGenesisHash') result = SOLANA_MAINNET_GENESIS;
    else if (body.method === 'getSlot')
      result = body.params[0].minContextSlot === undefined ? 100 : 103;
    else if (body.method === 'getTokenAccountsByOwner') {
      expect(body.params[0]).toBe(fixture.source.a);
      const index =
        body.params[1].programId === MARKETPLACE_TOKEN_PROGRAMS[0] ? 0 : 1;
      expect(body.params[2].minContextSlot).toBe(100 + index);
      result = {
        context: { slot: 101 + index },
        value: [
          fixture.account({
            id: index + 3,
            program: MARKETPLACE_TOKEN_PROGRAMS[index],
            amount: index === 0 ? 999n : 0n,
            extensions: index === 1 ? [{ __kind: 'ImmutableOwner' }] : [],
          }).raw,
        ],
      };
      await tokenHook?.();
    } else throw Error('Unexpected RPC method');
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  vi.restoreAllMocks();
  client.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function request(
  body: unknown = fixture.selection,
  headers: Record<string, string> = {
    origin: 'http://localhost',
    'content-type': 'application/json',
  },
  signal?: AbortSignal,
  query = '',
) {
  return POST(
    new Request(
      'http://localhost/api/marketplace/operator/token-inspection' + query,
      {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal,
      },
    ),
  );
}
it('requires verified operator access before SQL or providers, ignoring caller claims', async () => {
  mocks.user = null;
  expect((await request()).status).toBe(401);
  mocks.user = { userId: 'buyer' };
  expect((await request({ ...fixture.selection, operator: true })).status).toBe(
    403,
  );
  mocks.user = { userId: 'operator' };
  vi.stubEnv('MARKETPLACE_OPERATOR_USER_IDS', '*');
  expect((await request()).status).toBe(403);
  expect(queries).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
});
it('admits only same-origin bounded JSON with exact selection and no query selectors', async () => {
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
    (await request({ ...fixture.selection, ownerId: 'operator' })).status,
  ).toBe(400);
  expect(
    (await request(JSON.stringify({ padding: 'ü'.repeat(1100) }))).status,
  ).toBe(413);
  expect(queries).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
});
it('composes the real owned SQL reader, raw SDK fixtures and collector without any write except scoped pacing', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({
    inspection: {
      selection: fixture.selection,
      accountCount: 2,
      nonzeroRawAccounts: 1,
      extendedAccounts: 1,
      allAssetsAndAuthoritiesChecked: false,
      saleQualified: false,
      paymentAllowed: false,
      deliveryAllowed: false,
      signingAllowed: false,
    },
  });
  expect(methods).toEqual([
    'getGenesisHash',
    'getSlot',
    'getTokenAccountsByOwner',
    'getTokenAccountsByOwner',
    'getSlot',
  ]);
  expect(
    queries.every(
      (q) =>
        q.startsWith('SELECT') || q.startsWith('INSERT INTO market_read_gates'),
    ),
  ).toBe(true);
  const gate = await db
    .prepare('SELECT owner_id AS key FROM market_read_gates')
    .first<{ key: string }>();
  expect(gate?.key).toMatch(/^marketplace-token-inspection:[a-f0-9]{64}$/);
});
it('isolates its atomic cooldown from other wallet scopes and allows only one concurrent inspection', async () => {
  await db
    .prepare('INSERT INTO market_read_gates VALUES(?,?)')
    .bind('operator', Date.now() + 999999)
    .run();
  const responses = await Promise.all([request(), request()]);
  expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
    200, 429,
  ]);
  expect(methods).toHaveLength(5);
  expect(
    responses.find((r) => r.status === 429)?.headers.get('retry-after'),
  ).toBe('15');
});
it('refuses a foreign revision before RPC and changed owned sources afterwards', async () => {
  expect(
    (await request({ ...fixture.selection, address: fixture.source.b })).status,
  ).toBe(409);
  expect(fetcher).not.toHaveBeenCalled();
  await db.prepare('DELETE FROM market_read_gates').run();
  tokenHook = async () => {
    await db.prepare('UPDATE workspace_wallets SET revision=3').run();
  };
  expect((await request()).status).toBe(409);
});
it.each(['role', 'session'])(
  'withholds the response when %s changes during provider work',
  async (change) => {
    tokenHook = async () => {
      if (change === 'role') vi.stubEnv('MARKETPLACE_OPERATOR_USER_IDS', '[]');
      else mocks.user = { userId: 'other' };
    };
    expect((await request()).status).toBe(403);
  },
);
it('returns sanitized 429 and no partial inventory if the second program is rate limited', async () => {
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) =>
    typeof init?.body === 'string' &&
    init.body.includes(MARKETPLACE_TOKEN_PROGRAMS[1])
      ? new Response('secret upstream URL', { status: 429 })
      : original(url, init),
  );
  const response = await request();
  expect(response.status).toBe(429);
  const text = await response.text();
  expect(text).not.toContain('secret');
  expect(text).not.toContain('accountCount');
  expect(fetcher).toHaveBeenCalledTimes(4);
});
it('cancels before SQL and between program reads without retry', async () => {
  const stopped = new AbortController();
  stopped.abort();
  expect((await request(undefined, undefined, stopped.signal)).status).toBe(
    408,
  );
  expect(queries).toEqual([]);
  const pending = new AbortController();
  tokenHook = async () => {
    pending.abort();
  };
  expect((await request(undefined, undefined, pending.signal)).status).toBe(
    408,
  );
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it('refuses missing pacing schema without leaking SQL text', async () => {
  await db.prepare('DROP TABLE market_read_gates').run();
  const response = await request();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('market_read_gates');
  expect(fetcher).not.toHaveBeenCalled();
});
it('refuses malformed token bytes without returning a partial or empty inventory or raw decoder text', async () => {
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => {
    if (
      typeof init?.body === 'string' &&
      init.body.includes('getTokenAccountsByOwner')
    )
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          context: { slot: 101 },
          value: [
            {
              pubkey: fixture.key(3),
              account: {
                owner: MARKETPLACE_TOKEN_PROGRAMS[0],
                executable: false,
                lamports: 1,
                space: 165,
                data: ['bm90LXRva2Vu', 'base64'],
              },
            },
          ],
        },
      });
    return original(url, init);
  });
  const response = await request();
  expect(response.status).toBe(503);
  const text = await response.text();
  expect(text).not.toContain('encoding or layout');
  expect(text).not.toContain('accountCount');
  expect(fetcher).toHaveBeenCalledTimes(3);
});
