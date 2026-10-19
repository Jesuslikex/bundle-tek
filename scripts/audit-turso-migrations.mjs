import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  sqlMigrationChecksum,
  sqlMigrationChecksumMatches,
} from './migration-checksums.mjs';

export function checkMigrationLedger(entries, files, aliases, rows) {
  if (
    !entries.length ||
    entries.some(
      (entry, index) =>
        entry.idx !== index || !/^\d{4}_[a-z0-9_]+$/.test(entry.tag),
    )
  )
    throw new Error('Invalid local migration journal.');
  if (rows.length > entries.length)
    throw new Error('Database history is ahead of this source.');
  const applied = rows.map((row, index) => {
    const entry = entries[index],
      bytes = files.get(entry.tag);
    if (
      row.idx !== index ||
      row.tag !== entry.tag ||
      !bytes ||
      !sqlMigrationChecksumMatches(bytes, row.sha256, entry.tag, aliases)
    )
      throw new Error(
        'Applied migration history or checksum differs at index ' + index + '.',
      );
    return {
      idx: index,
      tag: entry.tag,
      sha256: row.sha256,
      canonicalSha256: sqlMigrationChecksum(bytes),
    };
  });
  return {
    passed: true,
    readOnly: true,
    applied: applied.length,
    total: entries.length,
    lastApplied: applied.at(-1)?.tag ?? null,
    checksumsMatched: applied.length,
    pending: entries
      .slice(applied.length)
      .map((entry) => ({
        idx: entry.idx,
        tag: entry.tag,
        sha256: sqlMigrationChecksum(files.get(entry.tag)),
      })),
    ledger: applied,
  };
}

/** This audit never invokes the migration runner or creates a missing ledger. */
export async function auditMigrationDatabase(db, entries, files, aliases) {
  const tx = await db.transaction('read');
  try {
    const schema = await tx.execute(
      "SELECT type,name FROM sqlite_master WHERE type IN ('table','trigger','index') AND name NOT LIKE 'sqlite_%' ORDER BY type,name",
    );
    if (
      !schema.rows.some(
        (row) => row.type === 'table' && row.name === 'bundle_migration_ledger',
      )
    )
      throw new Error('Production migration ledger is unavailable.');
    const result = await tx.execute({
      sql: 'SELECT idx,tag,sha256 FROM bundle_migration_ledger ORDER BY idx LIMIT ?',
      args: [entries.length + 1],
    });
    return {
      ...checkMigrationLedger(entries, files, aliases, result.rows),
      schemaObjects: schema.rows.map((row) => ({
        type: row.type,
        name: row.name,
      })),
    };
  } finally {
    await tx.rollback();
    tx.close();
  }
}

async function main() {
  if (process.argv.slice(2).join(' ') !== '--check-only')
    throw new Error('Use --check-only.');
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN)
    throw new Error('Database environment is unavailable.');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const entries = JSON.parse(
    readFileSync(resolve(root, 'drizzle/meta/_journal.json'), 'utf8'),
  ).entries;
  const files = new Map(
    entries.map((entry) => [
      entry.tag,
      readFileSync(resolve(root, 'drizzle', entry.tag + '.sql')),
    ]),
  );
  const aliases = JSON.parse(
    readFileSync(
      resolve(root, 'drizzle/meta/sql-checksum-aliases.json'),
      'utf8',
    ),
  );
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
    intMode: 'number',
  });
  try {
    console.log(
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          ...(await auditMigrationDatabase(db, entries, files, aliases)),
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch(() => {
    // Driver messages can contain private URLs or credentials. No raw exception output.
    console.error(
      JSON.stringify({
        passed: false,
        readOnly: true,
        reason:
          'Migration audit refused. Check source history, database access and ledger; provider details suppressed.',
      }),
    );
    process.exitCode = 1;
  });
}
