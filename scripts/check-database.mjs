// One-off: integrity and foreign-key check on a freshly migrated database.
import { createClient } from '@libsql/client';
import { resolve } from 'node:path';

const file = process.argv[2] ?? 'work/deploy-check.db';
const db = createClient({ url: 'file:' + resolve(file) });
const integrity = await db.execute('PRAGMA integrity_check');
const foreign = await db.execute('PRAGMA foreign_key_check');
const tables = await db.execute(
  "SELECT count(*) AS n FROM sqlite_master WHERE type='table'",
);
console.log('integrity:', integrity.rows[0]?.integrity_check);
console.log('foreign key violations:', foreign.rows.length);
console.log('tables:', tables.rows[0]?.n);
