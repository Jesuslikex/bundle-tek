import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import {
  saveHolderRunPage,
  holderRun,
  requireHolderRunPage,
  HolderIndexConflict,
  deleteHolderRun,
} from './holder-index-store';
import type { HolderIndexPage } from './holder-index';
import { supplyWallet } from '../test/supply-history-fixture';
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
it('persists withheld metadata in page JSON without adding it to owner-balance totals', async () => {
  const { db, sqlite } = database();
  const saved = {
    ...page(),
    enumeration: 'program-accounts-v2' as const,
    requestedCursor: null,
    nextCursor: null,
    tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  };
  saved.accounts = saved.accounts.map((account) => ({
    ...account,
    withheldRaw: '3',
  }));
  await saveHolderRunPage(db, 'owner', 'project', 1, 'fees', null, saved);
  const stored = sqlite
    .prepare('SELECT document FROM holder_index_pages WHERE run_id=?')
    .get('fees');
  if (typeof stored?.document !== 'string')
    throw new Error('Saved page missing.');
  expect(JSON.parse(stored.document).accounts[0].withheldRaw).toBe('3');
  expect((await holderRun(db, 'owner', 'project', 'fees'))?.indexed_raw).toBe(
    saved.accounts
      .reduce((total, account) => total + BigInt(account.raw), 0n)
      .toString(),
  );
});
it('removes only the selected owned run and preserves history on a stale revision', async () => {
  const { db, sqlite } = database();
  await saveHolderRunPage(db, 'owner', 'project', 1, 'run', null, page());
  await expect(
    deleteHolderRun(db, 'different-owner', 'project', 1, 'run'),
  ).rejects.toBeInstanceOf(HolderIndexConflict);
  await expect(
    deleteHolderRun(db, 'owner', 'project', 2, 'run'),
  ).rejects.toBeInstanceOf(HolderIndexConflict);
  expect(await holderRun(db, 'owner', 'project', 'run')).not.toBeNull();
  await deleteHolderRun(db, 'owner', 'project', 1, 'run');
  expect(await holderRun(db, 'owner', 'project', 'run')).toBeNull();
  expect(
    sqlite.prepare('SELECT COUNT(*) AS n FROM holder_index_pages').get()?.n,
  ).toBe(0);
  expect(
    sqlite.prepare('SELECT COUNT(*) AS n FROM holder_index_accounts').get()?.n,
  ).toBe(0);
});
function database() {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  sqlite.exec(readFileSync('drizzle/0067_petite_venus.sql', 'utf8'));
  sqlite.exec(
    'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,revision INTEGER,archived INTEGER,chain TEXT,address TEXT)',
  );
  sqlite
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,?,?,?)')
    .run('owner', 'project', 1, 0, 'Solana', supplyWallet(9));
  type Statement = {
    sql: string;
    values: Array<string | number>;
    bind: (...values: Array<string | number>) => Statement;
    first: () => Promise<unknown>;
    run: () => unknown;
  };
  const adapter = {
    prepare(sql: string) {
      const s: Statement = {
        sql,
        values: [],
        bind(...values) {
          s.values = values;
          return s;
        },
        async first() {
          return sqlite.prepare(sql).get(...s.values) ?? null;
        },
        run() {
          const r = sqlite.prepare(sql).run(...s.values);
          return { meta: { changes: Number(r.changes) } };
        },
      };
      return s;
    },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((s) => s.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { sqlite, db: adapter as unknown as D1Database };
}
const page = (n = 1, account = 1): HolderIndexPage => ({
  mint: supplyWallet(9),
  page: n,
  decimals: 6,
  totalSupplyRaw: '18446744073709551615',
  supplySlot: 200,
  indexedSlot: 190,
  observedAt: new Date().toISOString(),
  source: 'index.test',
  accounts: [
    {
      address: supplyWallet(account),
      owner: supplyWallet(7),
      raw: '9007199254740993',
      frozen: false,
    },
  ],
});
it('durably saves exact totals, resumes and isolates owner-scoped runs', async () => {
  const { db, sqlite } = database();
  await saveHolderRunPage(db, 'owner', 'project', 1, 'run', null, page());
  const first = await holderRun(db, 'owner', 'project', 'run');
  expect(first?.indexed_raw).toBe('9007199254740993');
  await saveHolderRunPage(db, 'owner', 'project', 1, 'run', first, page(2, 2));
  expect((await holderRun(db, 'owner', 'project', 'run'))?.indexed_raw).toBe(
    '18014398509481986',
  );
  expect(await holderRun(db, 'different-owner', 'project', 'run')).toBeNull();
  expect(
    sqlite.prepare('SELECT COUNT(*) AS n FROM holder_index_pages').get()?.n,
  ).toBe(2);
});
it('rolls back an overlapping page and leaves both header and account index unchanged', async () => {
  const { db, sqlite } = database();
  await saveHolderRunPage(db, 'owner', 'project', 1, 'run', null, page());
  const first = await holderRun(db, 'owner', 'project', 'run');
  await expect(
    saveHolderRunPage(db, 'owner', 'project', 1, 'run', first, page(2, 1)),
  ).rejects.toBeInstanceOf(HolderIndexConflict);
  expect((await holderRun(db, 'owner', 'project', 'run'))?.last_page).toBe(1);
  expect(
    sqlite.prepare('SELECT COUNT(*) AS n FROM holder_index_pages').get()?.n,
  ).toBe(1);
  expect(
    sqlite.prepare('SELECT COUNT(*) AS n FROM holder_index_accounts').get()?.n,
  ).toBe(1);
});
it('does not commit a stale concurrent page or a read whose project was invalidated', async () => {
  const { db, sqlite } = database();
  await saveHolderRunPage(db, 'owner', 'project', 1, 'run', null, page());
  const prior = await holderRun(db, 'owner', 'project', 'run');
  const next = page(2, 2);
  await saveHolderRunPage(db, 'owner', 'project', 1, 'run', prior, next);
  await expect(
    saveHolderRunPage(db, 'owner', 'project', 1, 'run', prior, next),
  ).rejects.toBeInstanceOf(HolderIndexConflict);
  expect((await holderRun(db, 'owner', 'project', 'run'))?.last_page).toBe(2);
  sqlite.exec('UPDATE imported_token_projects SET revision=2');
  await expect(
    saveHolderRunPage(db, 'owner', 'project', 1, 'fresh', null, page()),
  ).rejects.toBeInstanceOf(HolderIndexConflict);
  expect(await holderRun(db, 'owner', 'project', 'fresh')).toBeNull();
});
it('preserves stale saved runs for review while refusing to extend them', async () => {
  const { db } = database();
  await saveHolderRunPage(db, 'owner', 'project', 1, 'run', null, page());
  const run = (await holderRun(db, 'owner', 'project', 'run'))!;
  expect(() =>
    requireHolderRunPage(
      { ...run, updated_at: '2026-01-01T00:00:00Z' },
      page(2, 2),
    ),
  ).toThrow('too old');
});
