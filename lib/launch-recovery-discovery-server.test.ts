import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '@/db/turso';
import { readLaunchRecoveryPage } from './launch-recovery-discovery-server';
let client: Client, db: D1Database;
const tables = [
  'pump_launch_reviews',
  'venue_launch_recoveries',
  'launchlab_launch_recoveries',
];
beforeEach(async () => {
  client = createClient({ url: 'file::memory:' });
  db = createTursoDatabase(client);
  for (const t of tables)
    await db
      .prepare(
        `CREATE TABLE ${t}(id TEXT PRIMARY KEY,owner_id TEXT,project_id TEXT,project_document TEXT,mint TEXT,state TEXT,created_at TEXT,expires_at TEXT,signature TEXT,receipt TEXT,review TEXT,terms TEXT,venue TEXT)`,
      )
      .run();
});
afterEach(() => client.close());
async function add(
  t = 0,
  id = 'record',
  owner = 'alice',
  state = 'signed',
  format = 'pump-launch-group-review-v1',
  venue = ['pump', 'meteora-dbc', 'launchlab'][t],
) {
  await db
    .prepare(`INSERT INTO ${tables[t]} VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      id,
      owner,
      'project-1',
      JSON.stringify({
        plan: { tokenName: 'Saved name' },
        private: 'DO_NOT_EXPOSE',
      }),
      '11111111111111111111111111111111',
      state,
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T00:01:00.000Z',
      'SECRET_SIGNATURE',
      'SECRET_RECEIPT',
      JSON.stringify({ format, private: 'SECRET_REVIEW' }),
      '{}',
      venue,
    )
    .run();
}
const read = (cursor: string | null = null) =>
  readLaunchRecoveryPage(db, 'alice', cursor, new AbortController().signal);
it('selects owner-bound cross-venue scalar references without exposing private payloads', async () => {
  await add();
  await add(1);
  await add(2);
  await add(1, 'stonk', 'alice', 'submitting', 'x', 'stonkfun');
  for (let t = 0; t < 3; t++) {
    await add(t, 'other', 'bob');
    await add(t, 'done', 'alice', 'finalized');
  }
  const r = await read();
  expect(r.items.map((x) => x.source)).toEqual([
    'launchlab',
    'meteora-dbc',
    'pump',
    'stonkfun',
  ]);
  expect(r.items).toHaveLength(4);
  expect(JSON.stringify(r)).not.toMatch(/SECRET|DO_NOT_EXPOSE/);
  expect(r.items[0]).toMatchObject({
    projectName: 'Saved name',
    hasReceipt: true,
    hasSignature: true,
  });
  expect(r.receiptVerified).toBe(false);
});
it('pages stable ties without skipping or repeating records', async () => {
  for (let n = 0; n < 43; n++) await add(n % 3, String(n).padStart(3, '0'));
  const first = await read(),
    second = await read(first.nextCursor),
    third = await read(second.nextCursor);
  expect([first.items.length, second.items.length, third.items.length]).toEqual(
    [20, 20, 3],
  );
  expect(third.nextCursor).toBeNull();
  expect(
    new Set(
      [...first.items, ...second.items, ...third.items].map(
        (x) => x.source + x.id,
      ),
    ).size,
  ).toBe(43);
});
it('cursor never confers another owner access', async () => {
  for (let n = 0; n < 21; n++) await add(0, String(n));
  await add(1, 'bob', 'bob');
  const first = await read();
  const other = await readLaunchRecoveryPage(
    db,
    'bob',
    first.nextCursor,
    new AbortController().signal,
  );
  expect(other.items.every((x) => x.id === 'bob')).toBe(true);
});
it.each([0, 1, 2])(
  'fails closed if source table %s is unavailable',
  async (t) => {
    await add();
    await db.prepare(`DROP TABLE ${tables[t]}`).run();
    await expect(read()).rejects.toThrow();
  },
);
it.each(['unknown', ''])(
  'rejects unsupported stored state %s',
  async (state) => {
    await add(0, 'bad', 'alice', state);
    await expect(read()).rejects.toThrow();
  },
);
it('classifies Pump kinds and keeps unknown formats visible', async () => {
  for (const [n, f] of [
    'pump-launch-group-review-v1',
    'pump-create-holders-review-v1',
    'pump-create-buy-review-v1',
    'unknown',
  ].entries())
    await add(0, String(n), 'alice', 'review', f);
  await add(0, 'create');
  await db
    .prepare(`UPDATE pump_launch_reviews SET review='{}' WHERE id='create'`)
    .run();
  const r = await read();
  expect(new Set(r.items.map((x) => x.reviewKind))).toEqual(
    new Set(['groups', 'holders', 'developer', 'uncategorized', 'create']),
  );
});
it('aborts before starting any query', async () => {
  const c = new AbortController();
  c.abort();
  const prepare = vi.spyOn(db, 'prepare');
  await expect(
    readLaunchRecoveryPage(db, 'alice', null, c.signal),
  ).rejects.toThrow();
  expect(prepare).not.toHaveBeenCalled();
});

it('treats an explicitly null maximum quote cost as create-only', async () => {
  await add();
  await db
    .prepare(
      `UPDATE pump_launch_reviews SET review='{}',terms='{"maximumQuoteCostRaw":null}'`,
    )
    .run();
  expect((await read()).items[0].reviewKind).toBe('create');
});

it('refuses a corrupt null state instead of silently omitting it', async () => {
  await add();
  await db.prepare('UPDATE pump_launch_reviews SET state=NULL').run();
  await expect(read()).rejects.toThrow();
});

it('queries the actual committed table definitions without extra projection columns', async () => {
  for (const t of tables) await db.prepare(`DROP TABLE ${t}`).run();
  for (const file of [
    '0079_real_justice.sql',
    '0145_venue_launch_recoveries.sql',
    '0146_launchlab_launch_recoveries.sql',
  ]) {
    const first = readFileSync(
      new URL('../drizzle/' + file, import.meta.url),
      'utf8',
    ).split('--> statement-breakpoint')[0];
    await db.prepare(first).run();
  }
  expect((await read()).items).toEqual([]);
});
