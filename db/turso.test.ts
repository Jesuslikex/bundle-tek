import { createClient, type Client } from '@libsql/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTursoDatabase } from './turso';
let client: Client, db: D1Database;
beforeEach(async () => {
  client = createClient({ url: 'file::memory:', intMode: 'number' });
  db = createTursoDatabase(client);
  await client.execute(
    'CREATE TABLE records(id INTEGER PRIMARY KEY,owner TEXT UNIQUE,data BLOB,amount TEXT)',
  );
});
afterEach(() => client.close());
it('preserves prepared bindings, blobs, scalar reads, changes and returned rows', async () => {
  const insert = db.prepare(
    'INSERT INTO records(owner,data,amount) VALUES(?,?,?)',
  );
  const r = await insert
    .bind('alice', Uint8Array.of(1, 2, 3), '18446744073709551615')
    .run();
  expect(r.meta.changes).toBe(1);
  expect(
    await db
      .prepare('SELECT amount FROM records WHERE owner=?')
      .bind('alice')
      .first('amount'),
  ).toBe('18446744073709551615');
  const row = await db
    .prepare('SELECT data FROM records')
    .first<{ data: ArrayBuffer }>();
  expect([...new Uint8Array(row!.data)]).toEqual([1, 2, 3]);
  expect(
    (
      await db
        .prepare('UPDATE records SET amount=? WHERE owner=?')
        .bind('0', 'missing')
        .run()
    ).meta.changes,
  ).toBe(0);
  expect(
    await db
      .prepare('SELECT * FROM records WHERE owner=?')
      .bind('missing')
      .first(),
  ).toBeNull();
  expect(() => insert.bind('bad', null, Number.MAX_SAFE_INTEGER + 1)).toThrow();
});
it('rolls back a multi-statement write batch on trigger rejection', async () => {
  await client.execute(
    "CREATE TRIGGER protected_owner BEFORE INSERT ON records WHEN NEW.owner='blocked' BEGIN SELECT RAISE(ABORT,'blocked owner'); END;",
  );
  await expect(
    db.batch([
      db.prepare("INSERT INTO records(owner) VALUES('first')"),
      db.prepare("INSERT INTO records(owner) VALUES('blocked')"),
    ]),
  ).rejects.toThrow();
  expect((await db.prepare('SELECT * FROM records').all()).results).toEqual([]);
});
it('reports per-statement admission changes and rejects a foreign-client batch', async () => {
  const a = await db.batch([
    db.prepare("INSERT INTO records(owner) VALUES('alice')"),
    db.prepare(
      "INSERT INTO records(owner) VALUES('alice') ON CONFLICT(owner) DO NOTHING",
    ),
  ]);
  expect(a.map((r) => r.meta.changes)).toEqual([1, 0]);
  const other = createClient({ url: 'file::memory:' });
  try {
    await expect(
      db.batch([createTursoDatabase(other).prepare('SELECT 1')]),
    ).rejects.toThrow('foreign');
  } finally {
    other.close();
  }
});
