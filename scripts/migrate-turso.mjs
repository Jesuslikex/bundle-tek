import { createClient } from '@libsql/client';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [mode, target] = process.argv.slice(2);
if (
  !['--local', '--remote'].includes(mode) ||
  (mode === '--local' && !target) ||
  (mode === '--remote' && target)
)
  throw new Error('Use --local <disposable-file> or --remote.');
const local = mode === '--local';
if (local && existsSync(resolve(target)))
  throw new Error(
    'Local verification requires a new disposable database file.',
  );
const url = local ? 'file:' + resolve(target) : process.env.TURSO_DATABASE_URL;
if (!url || (!local && !process.env.TURSO_AUTH_TOKEN))
  throw new Error('Database environment is unavailable.');
const db = createClient({
  url,
  ...(!local ? { authToken: process.env.TURSO_AUTH_TOKEN } : {}),
  intMode: 'number',
});
try {
  const tables = (
    await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
  ).rows.map((r) => {
    if (typeof r.name !== 'string') throw new Error('Invalid schema name.');
    return r.name;
  });
  if (!tables.includes('bundle_migration_ledger') && tables.length)
    throw new Error('This is not an empty Bundle database. No changes made.');
  await db.execute(
    'CREATE TABLE IF NOT EXISTS bundle_migration_ledger(idx INTEGER PRIMARY KEY,tag TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL)',
  );
  const entries = JSON.parse(
    readFileSync(resolve(root, 'drizzle/meta/_journal.json'), 'utf8'),
  ).entries;
  const applied = (
    await db.execute(
      'SELECT idx,tag,sha256 FROM bundle_migration_ledger ORDER BY idx',
    )
  ).rows;
  if (applied.length > entries.length)
    throw new Error('Database history is ahead of this source.');
  let count = 0;
  for (const [idx, e] of entries.entries()) {
    if (e.idx !== idx) throw new Error('Migration journal is not sequential.');
    const bytes = readFileSync(resolve(root, 'drizzle', e.tag + '.sql')),
      sha256 = createHash('sha256').update(bytes).digest('hex');
    if (applied[idx]) {
      if (
        applied[idx].idx !== idx ||
        applied[idx].tag !== e.tag ||
        applied[idx].sha256 !== sha256
      )
        throw new Error('Applied migration checksum differs: ' + e.tag);
      continue;
    }
    const statements = bytes
      .toString('utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    const tx = await db.transaction('write');
    let statement = 0;
    try {
      for (const sql of statements) {
        await tx.execute(sql);
        statement++;
      }
      await tx.execute({
        sql: 'INSERT INTO bundle_migration_ledger VALUES(?,?,?,?)',
        args: [idx, e.tag, sha256, new Date().toISOString()],
      });
      await tx.commit();
      count++;
    } catch (error) {
      await tx.rollback();
      throw new Error(
        'Migration ' +
          e.tag +
          ' failed at statement ' +
          (statement + 1) +
          '. Its transaction was rolled back.',
        { cause: error },
      );
    } finally {
      tx.close();
    }
  }
  const ledger = (
    await db.execute(
      'SELECT idx,tag,sha256 FROM bundle_migration_ledger ORDER BY idx',
    )
  ).rows;
  const schema = (
    await db.execute(
      "SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
  ).rows;
  console.log(
    JSON.stringify({
      mode,
      migrations: ledger.length,
      newlyApplied: count,
      schemaObjects: schema.length,
      passed: ledger.length === entries.length,
    }),
  );
} finally {
  db.close();
}
