import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkMigrationLedger,
  auditMigrationDatabase,
} from './audit-turso-migrations.mjs';
import { sqlMigrationChecksum } from './migration-checksums.mjs';
import { createClient } from '@libsql/client';
const entries = [
  { idx: 0, tag: '0000_first' },
  { idx: 1, tag: '0001_second' },
];
const files = new Map(
  entries.map((entry) => [entry.tag, Buffer.from('SELECT 1;\n')]),
);
const rows = entries.map((entry) => ({
  ...entry,
  sha256: sqlMigrationChecksum(files.get(entry.tag)),
}));
test('checks a valid prefix and reports exact pending checksums', () => {
  const report = checkMigrationLedger(entries, files, {}, rows.slice(0, 1));
  assert.equal(report.checksumsMatched, 1);
  assert.deepEqual(report.pending, [rows[1]]);
  assert.equal(
    checkMigrationLedger(entries, files, {}, rows).pending.length,
    0,
  );
});
test('refuses ahead, missing, reordered, unknown and mismatched ledger history', () => {
  for (const invalid of [
    [...rows, rows[1]],
    [rows[1]],
    [rows[1], rows[0]],
    [{ ...rows[0], tag: '0000_other' }],
    [{ ...rows[0], sha256: '0'.repeat(64) }],
  ])
    assert.throws(() => checkMigrationLedger(entries, files, {}, invalid));
  assert.throws(() =>
    checkMigrationLedger([...entries].reverse(), files, {}, rows),
  );
});
function fixture({ missing = false, failure = false } = {}) {
  const calls = [];
  const tx = {
    execute: async (query) => {
      calls.push(query);
      if (typeof query === 'string')
        return {
          rows: missing
            ? []
            : [{ type: 'table', name: 'bundle_migration_ledger' }],
        };
      if (failure) throw new Error('Private provider error');
      return { rows };
    },
    rollback: async () => calls.push('rollback'),
    close: () => calls.push('close'),
  };
  return {
    calls,
    db: {
      transaction: async (mode) => {
        calls.push(mode);
        return tx;
      },
    },
  };
}
test('uses only bounded SELECTs inside a read transaction, then rolls back', async () => {
  const { db, calls } = fixture();
  assert.equal(
    (await auditMigrationDatabase(db, entries, files, {})).applied,
    2,
  );
  assert.equal(calls[0], 'read');
  assert.match(calls[1], /^SELECT /);
  assert.match(calls[2].sql, /^SELECT .* LIMIT \?$/);
  assert.deepEqual(calls[2].args, [3]);
  assert.deepEqual(calls.slice(-2), ['rollback', 'close']);
});
test('never creates a missing ledger and cleans up read failures', async () => {
  for (const options of [{ missing: true }, { failure: true }]) {
    const { db, calls } = fixture(options);
    await assert.rejects(auditMigrationDatabase(db, entries, files, {}));
    assert.deepEqual(calls.slice(-2), ['rollback', 'close']);
    assert.equal(
      calls.some((call) =>
        /CREATE|INSERT|UPDATE|DELETE/.test(
          typeof call === 'string' ? call : call.sql,
        ),
      ),
      false,
    );
  }
});

test('real libsql read transaction preserves an existing database and ledger', async () => {
  const db = createClient({ url: ':memory:', intMode: 'number' });
  try {
    await db.execute(
      'CREATE TABLE bundle_migration_ledger(idx INTEGER PRIMARY KEY,tag TEXT,sha256 TEXT)',
    );
    await db.execute({
      sql: 'INSERT INTO bundle_migration_ledger VALUES(?,?,?)',
      args: [rows[0].idx, rows[0].tag, rows[0].sha256],
    });
    const before = await db.execute('SELECT * FROM bundle_migration_ledger');
    assert.equal(
      (await auditMigrationDatabase(db, entries, files, {})).pending.length,
      1,
    );
    assert.deepEqual(
      (await db.execute('SELECT * FROM bundle_migration_ledger')).rows,
      before.rows,
    );
    assert.equal(
      (
        await db.execute(
          "SELECT count(*) AS n FROM sqlite_master WHERE type='table'",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    db.close();
  }
});
