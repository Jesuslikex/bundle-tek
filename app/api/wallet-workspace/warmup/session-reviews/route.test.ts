import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { warmupSessionReviewFixture } from '@/test/warmup-session-review-fixture';
import { loadWalletWarmupProgress } from '@/lib/wallet-warmup-progress-server';
import { reviewWalletWarmupSession } from '@/lib/wallet-warmup-session-review';
import { walletWarmupSessionDigest } from '@/lib/wallet-warmup-session-digest';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET, POST } from './route';
let mf: Miniflare,
  db: D1Database,
  input: Record<string, unknown>,
  statements: string[];
const fixture = warmupSessionReviewFixture();
const migration = readFileSync(
  'drizzle/0117_wallet_warmup_session_reviews.sql',
  'utf8',
)
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean);
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'warmup-session-reviews-api',
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
          env: { DB: { type: 'd1', id: 'warmup-session-reviews-api' } },
        },
      },
    ],
  });
  db = (await mf.getD1Database(
    'DB',
    'warmup-session-reviews-api',
  )) as unknown as D1Database;
  for (const sql of [
    'CREATE TABLE wallet_warmup_plans(owner_id TEXT,id TEXT,revision INTEGER,archived INTEGER,updated_at TEXT,document TEXT,PRIMARY KEY(owner_id,id))',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
    'CREATE TABLE warmup_buy_receipts(owner_id TEXT,plan_id TEXT,id TEXT,plan_revision INTEGER,wallet_revision INTEGER,cycle INTEGER,wallet_address TEXT,signature TEXT,remaining_raw TEXT,document TEXT)',
    'CREATE TABLE warmup_sell_receipts(owner_id TEXT,plan_id TEXT,id TEXT,buy_receipt_id TEXT,consumed_raw TEXT,signature TEXT,document TEXT)',
    'CREATE TABLE solana_swap_reservations(owner_id TEXT,intent_id TEXT,wallet_address TEXT,state TEXT)',
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT,state TEXT)',
  ])
    await db.prepare(sql).run();
});
afterAll(async () => mf?.dispose());
beforeEach(async () => {
  await db.prepare('DROP TABLE IF EXISTS wallet_warmup_session_reviews').run();
  for (const table of [
    'wallet_warmup_plans',
    'workspace_wallets',
    'warmup_buy_receipts',
    'warmup_sell_receipts',
    'solana_swap_reservations',
    'solana_execution_reservations',
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
  for (const sql of migration) await db.prepare(sql).run();
  await db
    .prepare('INSERT INTO wallet_warmup_plans VALUES(?,?,?,?,?,?)')
    .bind(
      'one',
      fixture.plan.id,
      1,
      0,
      fixture.plan.updatedAt,
      JSON.stringify(fixture.plan.document),
    )
    .run();
  await db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?)')
    .bind('one', 'Solana', fixture.plan.document.addresses[0], 1, 0)
    .run();
  const current = await loadWalletWarmupProgress(
      db,
      'one',
      fixture.plan.id,
      1,
      false,
      true,
    ),
    at = Date.now(),
    review = reviewWalletWarmupSession(
      current.plan,
      current.progress,
      current.performance,
      at,
    );
  input = {
    id: crypto.randomUUID(),
    planId: fixture.plan.id,
    revision: 1,
    reviewedAt: new Date(at).toISOString(),
    reviewSha256: await walletWarmupSessionDigest(review.contextKey),
    save: true,
  };
  mocks.user = { userId: 'one' };
  statements = [];
  mocks.db = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          statements.push(sql);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
});
function post(
  body: unknown = input,
  headers: Record<string, string> = {
    origin: 'http://localhost',
    'content-type': 'application/json',
  },
  signal?: AbortSignal,
) {
  return POST(
    new Request(
      'http://localhost/api/wallet-workspace/warmup/session-reviews',
      {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal,
      },
    ),
  );
}
function get(query = 'id=' + input.id, signal?: AbortSignal) {
  return GET(
    new Request(
      'http://localhost/api/wallet-workspace/warmup/session-reviews?' + query,
      { signal },
    ),
  );
}
it('authenticates both operations before reading or writing storage', async () => {
  mocks.user = null;
  expect((await post()).status).toBe(401);
  expect((await get()).status).toBe(401);
  expect(statements).toEqual([]);
});
it.each([
  {},
  { origin: 'https://elsewhere.example', 'content-type': 'application/json' },
  { origin: 'http://localhost', 'content-type': 'application/jsonp' },
] as Record<string, string>[])(
  'requires exact origin and JSON: %j',
  async (headers) => {
    expect([403, 415]).toContain((await post(input, headers)).status);
    expect(statements).toEqual([]);
  },
);
it.each([
  null,
  [],
  { save: undefined },
  { save: false },
  { manifest: {} },
  { revision: '1' },
])('refuses missing or client-supplied fields: %j', async (patch) => {
  const body =
    patch && typeof patch === 'object' && !Array.isArray(patch)
      ? { ...input, ...patch }
      : patch;
  const response = await post(body);
  expect(response.status).toBe(400);
  expect(statements).toEqual([]);
});
it('bounds UTF-8 JSON and refuses HTML or malformed request bodies', async () => {
  expect(
    (await post(JSON.stringify({ padding: 'ü'.repeat(1100) }))).status,
  ).toBe(413);
  expect((await post('<html>private upstream error</html>')).status).toBe(400);
  expect(statements).toEqual([]);
});
it.each(['id=wrong', 'other=value', 'id=a&id=b', 'id=a&extra=b'])(
  'requires exactly one canonical UUID recovery parameter: %s',
  async (query) => {
    expect((await get(query)).status).toBe(400);
    expect(statements).toEqual([]);
  },
);
it('saves the server-rebuilt review and reads the same owner-scoped immutable DTO without authority', async () => {
  const saved = await post();
  expect(saved.status).toBe(200);
  expect(saved.headers.get('cache-control')).toBe('no-store');
  const body = (await saved.json()) as {
    retainedReview: { document: unknown };
  };
  expect(body.retainedReview.document).toMatchObject({
    signingAllowed: false,
    executionAllowed: false,
    automaticExecutionAllowed: false,
  });
  expect(JSON.stringify(body)).not.toMatch(/planDocument|contextKey|owner_id/);
  const read = await get();
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual(body);
  mocks.user = { userId: 'two' };
  expect((await get()).status).toBe(404);
  expect((await post()).status).toBe(404);
});
it('returns 404 for an absent review without creating anything', async () => {
  const response = await get();
  expect(response.status).toBe(404);
  expect(statements.every((s) => s.startsWith('SELECT'))).toBe(true);
});
it('returns controlled conflicts for changed hashes, stale plans and expired reviews', async () => {
  expect((await post({ ...input, reviewSha256: '0'.repeat(64) })).status).toBe(
    409,
  );
  expect(
    (
      await post({
        ...input,
        reviewedAt: new Date(Date.now() - 61000).toISOString(),
      })
    ).status,
  ).toBe(409);
  await db.prepare('UPDATE wallet_warmup_plans SET revision=2').run();
  expect((await post()).status).toBe(409);
});
it('recovers the exact saved ID after archival without another INSERT', async () => {
  const first = await (await post()).json();
  await db
    .prepare('UPDATE wallet_warmup_plans SET revision=2,archived=1')
    .run();
  statements = [];
  expect(await (await post()).json()).toEqual(first);
  expect(statements.some((s) => s.startsWith('INSERT'))).toBe(false);
});
it('refuses cancelled operations before storage', async () => {
  const controller = new AbortController();
  controller.abort();
  expect((await post(input, undefined, controller.signal)).status).toBe(408);
  expect((await get(undefined, controller.signal)).status).toBe(408);
  expect(statements).toEqual([]);
});
it('sanitizes storage failures and never exposes an upstream HTML page', async () => {
  mocks.db = {
    prepare() {
      throw Error('<html>private database details</html>');
    },
  } as unknown as D1Database;
  for (const response of [await post(), await get()]) {
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/html|private database/);
  }
});
it('fails closed when immutable guards are missing', async () => {
  await db
    .prepare('DROP TRIGGER wallet_warmup_session_reviews_no_update')
    .run();
  expect((await post()).status).toBe(503);
  expect((await get()).status).toBe(503);
});
