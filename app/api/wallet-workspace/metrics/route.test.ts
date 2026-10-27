import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
const { GET } = await import('./route');
const a = '11111111111111111111111111111111';
const b = '22222222222222222222222222222222';
beforeEach(() => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE warmup_buy_receipts(id TEXT,owner_id TEXT,wallet_address TEXT,plan_id TEXT,document TEXT);
    CREATE TABLE warmup_sell_receipts(buy_receipt_id TEXT,document TEXT);
    CREATE TABLE wallet_cleanups(owner_id TEXT,wallet_address TEXT,batch_id TEXT,receipt TEXT);`);
  sqlite
    .prepare("INSERT INTO warmup_buy_receipts VALUES('1','alice',?,'plan-1',?)")
    .run(a, JSON.stringify({ nativeChangeRaw: -1000 }));
  sqlite
    .prepare("INSERT INTO warmup_buy_receipts VALUES('2','alice',?,'plan-1',?)")
    .run(a, JSON.stringify({ nativeChangeRaw: -500 }));
  sqlite
    .prepare('INSERT INTO warmup_sell_receipts VALUES(?,?)')
    .run('1', JSON.stringify({ nativeChangeRaw: 1800 }));
  sqlite
    .prepare("INSERT INTO wallet_cleanups VALUES('alice',?,'batch-1',?)")
    .run(b, JSON.stringify({ nativeChangeLamports: -300 }));
  sqlite
    .prepare("INSERT INTO wallet_cleanups VALUES('alice',?,'batch-1',?)")
    .run(b, JSON.stringify({ nativeChangeLamports: -200 }));
  sqlite
    .prepare("INSERT INTO wallet_cleanups VALUES('alice',?,'batch-2',NULL)")
    .run(b);
  sqlite
    .prepare("INSERT INTO warmup_buy_receipts VALUES('3','bob',?,'plan-9',?)")
    .run(b, JSON.stringify({ nativeChangeRaw: -9999 }));
  const prepare = (sql: string) => {
    const statement = {
      args: [] as SQLInputValue[],
      bind(...args: SQLInputValue[]) {
        statement.args = args;
        return statement;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...statement.args) };
      },
    };
    return statement;
  };
  mocks.db = { prepare } as unknown as D1Database;
  mocks.user = { userId: 'alice' };
});
it('aggregates volume, pnl and launches per wallet', async () => {
  const response = await GET(new Request('http://localhost/api/wallet-workspace/metrics'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    metrics: {
      [a]: { volume: 3300, pnl: 300, launches: 1 },
      [b]: { volume: 500, pnl: -500, launches: 0 },
    },
  });
});
it('counts a cleanup batch as no launch', async () => {
  const response = await GET(new Request('http://localhost/api/wallet-workspace/metrics'));
  const body = (await response.json()) as {
    metrics: Record<string, { launches: number }>;
  };
  expect(body.metrics[b].launches).toBe(0);
});
it('omits wallets with no receipts', async () => {
  const response = await GET(new Request('http://localhost/api/wallet-workspace/metrics'));
  const body = (await response.json()) as { metrics: Record<string, unknown> };
  expect(Object.keys(body.metrics)).toHaveLength(2);
});
it('requires a signed-in owner', async () => {
  mocks.user = null;
  const response = await GET(new Request('http://localhost/api/wallet-workspace/metrics'));
  expect(response.status).toBe(401);
});
