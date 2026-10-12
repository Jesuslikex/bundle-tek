import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { directMovementFixture } from '../../../../test/direct-movement-fixture';
import { classifyWalletMovement } from '@/lib/wallet-movement-classification';
import type {
  PoolTradeMovement,
  PoolTradeMovementContext,
} from '@/lib/pool-trade-movement';
const mocks = vi.hoisted(() => ({
  user: { userId: 'owner' } as { userId: string } | null,
  db: null as unknown as D1Database,
  observe: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/pool-trade-movement-server', () => ({
  observePoolTradeMovement: mocks.observe,
}));
import { POST } from './route';
const id = '11111111-1111-4111-8111-111111111111',
  signature = bs58.encode(new Uint8Array(64).fill(1));
let sqlite: DatabaseSync, c: PoolTradeMovementContext;
let selection: {
  id: string;
  revision: number;
  pool: string;
  tradeId: string;
  tapeObservedAt: string;
};
beforeEach(() => {
  mocks.user = { userId: 'owner' };
  mocks.observe.mockReset();
  const tx = directMovementFixture(0, 0),
    time = new Date().toISOString();
  c = {
    projectId: id,
    revision: 1,
    pool: tx.tokenChanges[0].mint,
    mint: tx.tokenChanges[1].mint,
    decimals: 6,
    tapeObservedAt: time,
    trade: {
      id: 'saved-trade',
      sender: tx.address,
      transaction: signature,
      block: 100,
      timestamp: time,
      side: 'Buy',
      tokenAmount: '0.001',
      quoteAmount: '0.001',
      priceUsd: '1',
      volumeUsd: '1',
    },
  };
  selection = {
    id,
    revision: 1,
    pool: c.pool,
    tradeId: c.trade.id,
    tapeObservedAt: time,
  };
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(
    'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER,document TEXT); CREATE TABLE imported_pool_trades(owner_id TEXT,project_id TEXT,document TEXT); CREATE TABLE wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER);',
  );
  sqlite
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,?,?,?,?)')
    .run(
      'owner',
      id,
      'Solana',
      c.mint,
      1,
      0,
      JSON.stringify({
        token: { chain: 'Solana', address: c.mint, decimals: 6 },
      }),
    );
  sqlite
    .prepare('INSERT INTO imported_pool_trades VALUES(?,?,?)')
    .run(
      'owner',
      id,
      JSON.stringify([
        {
          pool: c.pool,
          chain: 'Solana',
          address: c.mint,
          projectRevision: 1,
          observedAt: time,
          trades: [c.trade],
        },
      ]),
    );
  mocks.db = {
    prepare(sql: string) {
      return {
        bind(...values: (string | number | null)[]) {
          return {
            async first() {
              return sqlite.prepare(sql).get(...values) ?? null;
            },
            async run() {
              const result = sqlite.prepare(sql).run(...values);
              return { meta: { changes: Number(result.changes) } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const result: PoolTradeMovement = {
    format: 'pool-trade-movement-v1',
    executionAllowed: false,
    projectId: id,
    revision: 1,
    pool: c.pool,
    mint: c.mint,
    wallet: c.trade.sender,
    signature,
    tradeId: c.trade.id,
    tapeObservedAt: time,
    slot: 100,
    providerBlock: 100,
    blockAgrees: true,
    blockTime: null,
    commitment: 'confirmed',
    failed: false,
    walletSigner: true,
    providerSide: 'Buy',
    sideAgrees: true,
    tokenChange: {
      beforeRaw: '0',
      afterRaw: '1000',
      changeRaw: '1000',
      decimals: 6,
    },
    classification: classifyWalletMovement(tx, c.mint),
    observedAt: time,
    source: 'rpc.fixture.test',
  };
  mocks.observe.mockResolvedValue(result);
});
afterEach(() => sqlite.close());
const request = (
  body: unknown = selection,
  headers: Record<string, string> = {},
) =>
  new Request('http://localhost/api/imported-projects/trade-movement', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
it('requires authenticated same-origin bounded JSON without allowing an arbitrary transaction proxy', async () => {
  mocks.user = null;
  expect((await POST(request())).status).toBe(401);
  mocks.user = { userId: 'owner' };
  expect(
    (await POST(request(selection, { origin: 'https://unrelated.test' })))
      .status,
  ).toBe(403);
  expect(
    (await POST(request(selection, { 'content-type': 'text/plain' }))).status,
  ).toBe(415);
  expect((await POST(request({ ...selection, signature }))).status).toBe(400);
  expect(
    (await POST(request({ ...selection, tradeId: 'x'.repeat(1500) }))).status,
  ).toBe(413);
  expect(mocks.observe).not.toHaveBeenCalled();
});
it('only reads an owned current retained trade and shares existing provider pacing', async () => {
  mocks.user = { userId: 'other' };
  expect((await POST(request())).status).toBe(404);
  mocks.user = { userId: 'owner' };
  expect(
    (await POST(request({ ...selection, tradeId: 'not-retained' }))).status,
  ).toBe(409);
  expect((await POST(request({ ...selection, revision: 2 }))).status).toBe(409);
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(
    ((await response.json()) as { result: PoolTradeMovement }).result
      .classification.protocol,
  ).toBe('PumpSwap');
  expect((await POST(request())).status).toBe(429);
  expect(mocks.observe).toHaveBeenCalledTimes(1);
});
it('rejects archive and tape/project changes during provider work', async () => {
  sqlite.prepare('UPDATE imported_token_projects SET archived=1').run();
  expect((await POST(request())).status).toBe(409);
  sqlite.prepare('UPDATE imported_token_projects SET archived=0').run();
  const value = await mocks.observe();
  mocks.observe.mockClear();
  mocks.observe.mockImplementation(async () => {
    sqlite.prepare('UPDATE imported_token_projects SET revision=2').run();
    return value;
  });
  expect((await POST(request())).status).toBe(409);
});
it('refuses missing or substituted chain evidence without changing saved provider records', async () => {
  mocks.observe.mockRejectedValue(new Error('unavailable'));
  expect((await POST(request())).status).toBe(502);
  expect(
    sqlite.prepare('SELECT count(*) AS n FROM imported_pool_trades').get()?.n,
  ).toBe(1);
  sqlite.prepare('DELETE FROM wallet_balance_gates').run();
  mocks.observe.mockResolvedValue({ projectId: 'wrong' });
  expect((await POST(request())).status).toBe(502);
});
