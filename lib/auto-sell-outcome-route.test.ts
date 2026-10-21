import { DatabaseSync } from 'node:sqlite';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  autoSellOutcomePage,
  autoSellOutcomeReference as ref,
} from '../test/auto-sell-outcome-fixture';
import { savedAutoSellOutcome } from './auto-sell-outcome';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET } from '../app/api/imported-projects/signing/route';
let sqlite: DatabaseSync;
const statements: string[] = [];
beforeEach(() => {
  mocks.user = { userId: 'alice' };
  statements.length = 0;
  sqlite = new DatabaseSync(':memory:');
  // Read-side projections only. This does not exercise financial write guards.
  sqlite.exec(`CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,revision INTEGER,archived INTEGER);
  CREATE TABLE imported_swap_preparations(id TEXT,owner_id TEXT,project_id TEXT,project_revision INTEGER,wallet_revision INTEGER,document TEXT);
  CREATE TABLE imported_swap_signing_intents(id TEXT,owner_id TEXT,preparation_id TEXT,wallet_address TEXT,document TEXT,state TEXT,signature TEXT,failure_receipt TEXT,created_at TEXT,updated_at TEXT);`);
  const row = autoSellOutcomePage().intents[0];
  sqlite
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,8,1)')
    .run('alice', ref.projectId);
  sqlite
    .prepare('INSERT INTO imported_swap_preparations VALUES(?,?,?,?,?,?)')
    .run(
      ref.preparationId,
      'alice',
      ref.projectId,
      ref.projectRevision,
      ref.walletRevision,
      JSON.stringify({ side: 'Sell' }),
    );
  sqlite
    .prepare(
      'INSERT INTO imported_swap_signing_intents VALUES(?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      ref.intentId,
      'alice',
      ref.preparationId,
      ref.wallet,
      JSON.stringify(row.document),
      row.state,
      row.signature,
      null,
      row.createdAt,
      row.updatedAt,
    );
  mocks.db = {
    prepare(sql: string) {
      if (!/^\s*SELECT\b/i.test(sql)) throw Error('Only saved reads allowed');
      statements.push(sql);
      let values: (string | number | null)[] = [];
      return {
        bind(...args: (string | number | null)[]) {
          values = args;
          return this;
        },
        async first() {
          return sqlite.prepare(sql).get(...values) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...values) };
        },
      };
    },
  } as unknown as D1Database;
});
afterEach(() => sqlite.close());
const read = () =>
  GET(
    new Request(
      `http://local/api/imported-projects/signing?projectId=${ref.projectId}&intentId=${ref.intentId}`,
    ),
  );
it('composes actual saved GET and parser on an original archived, prior-revision approval without writes', async () => {
  const before = sqlite
    .prepare('SELECT * FROM imported_swap_signing_intents')
    .all();
  const response = await read();
  expect(response.status).toBe(200);
  const result = savedAutoSellOutcome(await response.json(), ref);
  expect(result).toMatchObject({
    state: 'submitted',
    signature: ref.signature,
    finalityVerified: false,
    submissionAllowed: false,
    signingAllowed: false,
  });
  expect(
    sqlite.prepare('SELECT * FROM imported_swap_signing_intents').all(),
  ).toEqual(before);
  expect(statements.length).toBeGreaterThan(0);
  expect(statements.every((s) => /^\s*SELECT\b/i.test(s))).toBe(true);
});
it('requires sign-in before any saved lookup read', async () => {
  mocks.user = null;
  expect((await read()).status).toBe(401);
  expect(statements).toHaveLength(0);
});
it('refuses another owner even with an exact known project and approval ID', async () => {
  mocks.user = { userId: 'bob' };
  expect((await read()).status).toBe(404);
});
it('does not adopt a known approval that belongs to another owned project', async () => {
  const other = '44444444-4444-4444-8444-444444444444';
  sqlite
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,1,0)')
    .run('alice', other);
  sqlite
    .prepare('UPDATE imported_swap_preparations SET project_id=?')
    .run(other);
  expect((await read()).status).toBe(404);
});
