import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '@/db/turso';
import { validatedAccountLaunchActivity } from '@/lib/account-launch-activity';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET } from './route';

const tables = [
  'pump_launch_reviews(id TEXT PRIMARY KEY,owner_id TEXT,project_id TEXT,mint TEXT,review TEXT,state TEXT,receipt TEXT,created_at TEXT)',
  'pump_group_broadcast_closures(review_id TEXT PRIMARY KEY,owner_id TEXT,receipt TEXT,state TEXT,created_at TEXT)',
];
const id = (n: number) =>
  `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const date = '2026-10-18T10:00:00.000Z';
const mint = '11111111111111111111111111111111';
let client: Client;

beforeAll(async () => {
  client = createClient({ url: 'file::memory:' });
  mocks.db = createTursoDatabase(client);
  for (const table of tables)
    await mocks.db.prepare(`CREATE TABLE ${table}`).run();
});
afterAll(() => client?.close());
beforeEach(async () => {
  mocks.user = { userId: 'alice' };
  for (const table of tables)
    await mocks.db.prepare(`DELETE FROM ${table.split('(')[0]}`).run();
});

async function launch(
  n: number,
  owner: string,
  state: string,
  closure: string | null,
) {
  const reviewId = id(n);
  const receipt = closure ? `receipt-${n}` : null;
  await mocks.db
    .prepare('INSERT INTO pump_launch_reviews VALUES(?,?,?,?,?,?,?,?)')
    .bind(
      reviewId,
      owner,
      id(n + 100),
      mint,
      JSON.stringify({ format: 'pump-launch-group-review-v1' }),
      state,
      receipt,
      date,
    )
    .run();
  if (closure)
    await mocks.db
      .prepare('INSERT INTO pump_group_broadcast_closures VALUES(?,?,?,?,?)')
      .bind(reviewId, owner, receipt, closure, date)
      .run();
}

it('returns exact owner-only counts and recent states without implying P&L', async () => {
  await launch(1, 'alice', 'finalized', 'finalized');
  await launch(2, 'alice', 'review', null);
  await launch(3, 'alice', 'finalized', 'failed');
  await launch(4, 'bob', 'finalized', 'finalized');

  const response = await GET(
    new Request('https://bundle.test/api/account-launch-activity'),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const value = validatedAccountLaunchActivity(await response.json());
  expect(value).toMatchObject({
    savedGroups: 3,
    finalizedGroups: 1,
    awaitingReview: 1,
    finalizationEvidenceMissing: 1,
  });
  expect(value.recent.map((item) => item.id)).toEqual([id(3), id(2), id(1)]);
  expect(value.recent[0].settlementState).toBe('failed');
});

it('requires sign-in and rejects caller-selected query filters', async () => {
  mocks.user = null;
  expect(
    (await GET(new Request('https://bundle.test/api/account-launch-activity')))
      .status,
  ).toBe(401);
  mocks.user = { userId: 'alice' };
  expect(
    (
      await GET(
        new Request(
          'https://bundle.test/api/account-launch-activity?owner=bob',
        ),
      )
    ).status,
  ).toBe(400);
});

it('never counts another owner or a mismatched receipt as finalized evidence', async () => {
  await launch(1, 'alice', 'finalized', 'finalized');
  await launch(2, 'alice', 'finalized', 'finalized');
  await mocks.db
    .prepare(
      'UPDATE pump_group_broadcast_closures SET owner_id=? WHERE review_id=?',
    )
    .bind('bob', id(1))
    .run();
  await mocks.db
    .prepare(
      'UPDATE pump_group_broadcast_closures SET receipt=? WHERE review_id=?',
    )
    .bind('different-receipt', id(2))
    .run();
  const response = await GET(
    new Request('https://bundle.test/api/account-launch-activity'),
  );
  const result = validatedAccountLaunchActivity(await response.json());
  expect(result).toMatchObject({
    savedGroups: 2,
    finalizedGroups: 0,
    finalizationEvidenceMissing: 2,
  });
  expect(
    result.recent.every(
      (item) => item.settlementState === null && item.settledAt === null,
    ),
  ).toBe(true);
  expect(JSON.stringify(result)).not.toContain('receipt');
});

it('counts the whole owner history while returning only eight newest Pump group reviews', async () => {
  for (let n = 1; n <= 10; n++) await launch(n, 'alice', 'review', null);
  await launch(11, 'alice', 'review', null);
  await mocks.db
    .prepare('UPDATE pump_launch_reviews SET review=? WHERE id=?')
    .bind(JSON.stringify({ format: 'pump-launch-review-v1' }), id(11))
    .run();
  await mocks.db
    .prepare('UPDATE pump_launch_reviews SET created_at=? WHERE id=?')
    .bind('2026-10-18T11:00:00.000Z', id(1))
    .run();
  const response = await GET(
    new Request('https://bundle.test/api/account-launch-activity'),
  );
  const result = validatedAccountLaunchActivity(await response.json());
  expect(result).toMatchObject({
    savedGroups: 10,
    awaitingReview: 10,
    finalizedGroups: 0,
  });
  expect(result.recent.map((item) => item.id)).toEqual(
    [1, 10, 9, 8, 7, 6, 5, 4].map(id),
  );
  expect(Object.keys(result.recent[0]).sort()).toEqual([
    'createdAt',
    'id',
    'mint',
    'settledAt',
    'settlementState',
    'state',
  ]);
});

it('returns honest empty counts and withholds malformed stored records', async () => {
  const empty = await GET(
    new Request('https://bundle.test/api/account-launch-activity'),
  );
  expect(validatedAccountLaunchActivity(await empty.json())).toMatchObject({
    savedGroups: 0,
    recent: [],
  });
  await launch(1, 'alice', 'review', null);
  await mocks.db
    .prepare('UPDATE pump_launch_reviews SET created_at=?')
    .bind('invalid-date')
    .run();
  expect(
    (await GET(new Request('https://bundle.test/api/account-launch-activity')))
      .status,
  ).toBe(503);
});

it('withholds partial results if launch settlement storage is missing', async () => {
  await mocks.db.prepare('DROP TABLE pump_group_broadcast_closures').run();
  const response = await GET(
    new Request('https://bundle.test/api/account-launch-activity'),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error:
      'Saved launch activity could not be checked completely. No partial counts are shown.',
  });
  await mocks.db
    .prepare(
      'CREATE TABLE pump_group_broadcast_closures(review_id TEXT PRIMARY KEY,owner_id TEXT,receipt TEXT,state TEXT,created_at TEXT)',
    )
    .run();
});
