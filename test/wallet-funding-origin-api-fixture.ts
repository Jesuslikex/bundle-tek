import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fundingOriginFixture } from './wallet-funding-origin-fixture';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
export function fundingOriginApiFixture(count = 1) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,archived INTEGER,revision INTEGER);CREATE TABLE imported_token_project_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER NOT NULL);',
  );
  const queries: { sql: string; bindings: number }[] = [];
  const db = {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      const query = { sql, bindings: 0 };
      queries.push(query);
      return {
        bind(...args: SQLInputValue[]) {
          values = args;
          query.bindings = args.length;
          return this;
        },
        async all() {
          return { success: true, results: sqlite.prepare(sql).all(...values) };
        },
        async run() {
          return {
            success: true,
            meta: {
              changes: Number(sqlite.prepare(sql).run(...values).changes),
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const records = Array.from({ length: count }, (_, i) =>
    fundingOriginFixture(false, false, false, 10 + i),
  );
  const wallets = records.map((f) => {
    sqlite
      .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?)')
      .run('owner', 'Solana', f.wallet, 0, 1);
    return { address: f.wallet, revision: 1 };
  });
  const calls: string[] = [];
  async function rpc(method: string, params: unknown[]) {
    calls.push(method);
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getTransactionsForAddress') {
      const f = records.find((f) => f.wallet === params[0]);
      return {
        data: f?.history.data.length
          ? [
              {
                ...f.receipt,
                transactionIndex: f.history.data[0].transactionIndex,
              },
            ]
          : [],
        paginationToken: null,
      };
    }
    if (method === 'getSignatureStatuses')
      return {
        context: { slot: '1000' },
        value: (params[0] as string[]).map((signature) => {
          const f = records.find(
            (f) => f.history.data[0]?.signature === signature,
          );
          return f
            ? {
                slot: f.receipt.slot,
                err: null,
                confirmationStatus: 'finalized',
                confirmations: null,
              }
            : null;
        }),
      };
    throw Error('Unexpected RPC method.');
  }
  return {
    sqlite,
    db,
    queries,
    records,
    wallets,
    calls,
    rpc,
    endpoint: 'https://solana-mainnet.g.alchemy.com/v2/fixture-private',
    close() {
      sqlite.close();
    },
  };
}
