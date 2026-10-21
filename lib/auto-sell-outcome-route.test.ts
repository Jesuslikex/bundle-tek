import { DatabaseSync } from 'node:sqlite';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  autoSellOutcomePage,
  autoSellOutcomeReference as ref,
} from '../test/auto-sell-outcome-fixture';
import { savedAutoSellOutcome } from './auto-sell-outcome';
import { autoSellSavedOutcomePage } from './auto-sell-saved-outcomes';
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

it('rediscovers archived/prior-revision saved Sell state through actual project history without a local reference', async () => {
  const response = await GET(
    new Request(
      `http://local/api/imported-projects/signing?projectId=${ref.projectId}`,
    ),
  );
  expect(response.status).toBe(200);
  const result = autoSellSavedOutcomePage(await response.json(), {
    projectId: ref.projectId,
    mint: ref.mint,
  });
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({
    intentId: ref.intentId,
    projectRevision: 7,
    state: 'submitted',
    finalityVerified: false,
    signingAllowed: false,
    submissionAllowed: false,
  });
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC-UNSIGNED');
  expect(statements.every((s) => /^\s*SELECT\b/i.test(s))).toBe(true);
});
it('composes real cursor pagination through a page with zero Sell matches, without skipping the older Sell', async () => {
  const original = autoSellOutcomePage().intents[0];
  for (let n = 1; n <= 51; n++) {
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const prep = `00000000-0000-4000-8001-${String(n).padStart(12, '0')}`;
    const created = new Date(
      Date.parse('2026-10-02T00:00:00Z') + n * 1000,
    ).toISOString();
    sqlite
      .prepare('INSERT INTO imported_swap_preparations VALUES(?,?,?,?,?,?)')
      .run(prep, 'alice', ref.projectId, 7, 9, JSON.stringify({ side: 'Buy' }));
    sqlite
      .prepare(
        'INSERT INTO imported_swap_signing_intents VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        'alice',
        prep,
        ref.wallet,
        JSON.stringify({
          ...original.document,
          id,
          preparationId: prep,
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: ref.mint,
        }),
        'submitted',
        ref.signature,
        null,
        created,
        created,
      );
  }
  const before = sqlite
    .prepare('SELECT * FROM imported_swap_signing_intents ORDER BY id')
    .all();
  const response = await GET(
    new Request(
      `http://local/api/imported-projects/signing?projectId=${ref.projectId}`,
    ),
  );
  expect(response.status).toBe(200);
  const first = autoSellSavedOutcomePage(await response.json(), {
    projectId: ref.projectId,
    mint: ref.mint,
  });
  expect(first.scanned).toBe(50);
  expect(first.rows).toEqual([]);
  expect(first.nextCursor).not.toBeNull();
  const older = await GET(
    new Request(
      `http://local/api/imported-projects/signing?projectId=${ref.projectId}&cursor=${first.nextCursor}`,
    ),
  );
  expect(older.status).toBe(200);
  const last = autoSellSavedOutcomePage(await older.json(), {
    projectId: ref.projectId,
    mint: ref.mint,
    cursor: first.nextCursor,
  });
  expect(last.scanned).toBe(2);
  expect(last.nextCursor).toBeNull();
  expect(last.rows.map((r) => r.intentId)).toEqual([ref.intentId]);
  expect(
    sqlite
      .prepare('SELECT * FROM imported_swap_signing_intents ORDER BY id')
      .all(),
  ).toEqual(before);
  expect(statements.every((s) => /^\s*SELECT\b/i.test(s))).toBe(true);
});
