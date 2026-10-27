import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  supply: { amount: '1000000', decimals: 2 },
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/wallet-balances', async (original) => ({
  ...(await original<typeof import('@/lib/wallet-balances')>()),
  balanceRpc: async () => ({ value: mocks.supply }),
}));
vi.mock('@/lib/solana-rpc', () => ({
  getSolanaIndexerRpcEndpoint: () => 'https://rpc.test',
}));
const { GET } = await import('./route');
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const other = 'So11111111111111111111111111111111111111112';
const snapshot = (holdings: { mint: string; raw: string }[]) =>
  JSON.stringify({ chain: 'Solana', holdings });
beforeEach(() => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,archived INTEGER);
    CREATE TABLE wallet_holdings_snapshots(owner_id TEXT,chain TEXT,address TEXT,document TEXT);`);
  const wallet = (address: string) =>
    sqlite
      .prepare("INSERT INTO workspace_wallets VALUES('alice','Solana',?,0)")
      .run(address);
  const hold = (address: string, document: string) =>
    sqlite
      .prepare("INSERT INTO wallet_holdings_snapshots VALUES('alice','Solana',?,?)")
      .run(address, document);
  wallet('11111111111111111111111111111111');
  wallet('22222222222222222222222222222222');
  wallet('33333333333333333333333333333333');
  hold('11111111111111111111111111111111', snapshot([{ mint, raw: '250000' }]));
  hold('22222222222222222222222222222222', snapshot([{ mint, raw: '50000' }]));
  hold('33333333333333333333333333333333', snapshot([{ mint: other, raw: '9' }]));
  const prepare = (sql: string) => {
    const statement = {
      args: [] as SQLInputValue[],
      bind(...args: SQLInputValue[]) {
        return Object.assign(prepare(sql), { args });
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
it('returns the dominant mint, its supply and per-wallet balances', async () => {
  const response = await GET(
    new Request('http://localhost/api/wallet-workspace/cleanup/holdings'),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    mint,
    supplyRaw: '1000000',
    decimals: 2,
    balances: {
      '11111111111111111111111111111111': '250000',
      '22222222222222222222222222222222': '50000',
    },
  });
});
it('honours an explicit mint', async () => {
  const response = await GET(
    new Request(`http://localhost/api/wallet-workspace/cleanup/holdings?mint=${other}`),
  );
  const body = (await response.json()) as { balances: Record<string, string> };
  expect(body.balances).toEqual({
    '33333333333333333333333333333333': '9',
  });
});
it('rejects a malformed mint', async () => {
  const response = await GET(
    new Request('http://localhost/api/wallet-workspace/cleanup/holdings?mint=nope'),
  );
  expect(response.status).toBe(400);
});
it('requires a signed-in owner', async () => {
  mocks.user = null;
  const response = await GET(
    new Request('http://localhost/api/wallet-workspace/cleanup/holdings'),
  );
  expect(response.status).toBe(401);
});
