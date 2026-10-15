import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { createClient } from '@libsql/client';
import {
  sqlMigrationChecksum,
  sqlMigrationChecksumMatches,
} from './migration-checksums.mjs';
const hash = (value: Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const lf = Buffer.from(
  "CREATE TABLE x(id TEXT);\n-- comment 'ignored'\nINSERT INTO x VALUES('same');\n",
);
const crlf = Buffer.from(lf.toString().replaceAll('\n', '\r\n'));
const aliases = JSON.parse(
  readFileSync('drizzle/meta/sql-checksum-aliases.json', 'utf8'),
);
it('gives new ledgers one stable checksum for physical LF/CRLF and preserves source bytes', () => {
  const before = Buffer.from(crlf);
  expect(sqlMigrationChecksum(lf)).toBe(sqlMigrationChecksum(crlf));
  expect(crlf).toEqual(before);
  for (const bytes of [lf, crlf])
    for (const applied of [hash(lf), hash(crlf)])
      expect(
        sqlMigrationChecksumMatches(bytes, applied, 'unlisted', aliases),
      ).toBe(true);
});
it('accepts only audited mixed-EOL aliases bound to the exact current canonical SQL and migration tag', () => {
  for (const tag of Object.keys(aliases.migrations)) {
    const bytes = execFileSync('git', ['show', 'HEAD:drizzle/' + tag + '.sql']);
    expect(
      sqlMigrationChecksumMatches(
        bytes,
        aliases.migrations[tag].legacySha256[0],
        tag,
        aliases,
      ),
    ).toBe(true);
    expect(
      sqlMigrationChecksumMatches(
        bytes,
        aliases.migrations[tag].legacySha256[0],
        'wrong',
        aliases,
      ),
    ).toBe(false);
    expect(
      sqlMigrationChecksumMatches(
        Buffer.concat([bytes, Buffer.from(' ')]),
        aliases.migrations[tag].legacySha256[0],
        tag,
        aliases,
      ),
    ).toBe(false);
  }
});
it('rejects modified SQL, comments, literals, whitespace and invalid ledger hashes', () => {
  for (const changed of [
    lf.toString().replace('same', 'other'),
    lf.toString().replace('id TEXT', 'id INTEGER'),
    lf.toString().replace('ignored', 'new comment'),
    lf.toString() + ' ',
    lf.toString().replace('x(id', 'x (id'),
  ])
    expect(
      sqlMigrationChecksumMatches(Buffer.from(changed), hash(lf), 'x', aliases),
    ).toBe(false);
  for (const invalid of [
    '',
    null,
    'f'.repeat(63),
    'F'.repeat(64),
    'z'.repeat(64),
  ])
    expect(sqlMigrationChecksumMatches(lf, invalid, 'x', aliases)).toBe(false);
});
it('preserves line-break bytes inside every supported quote form, including escaped quotes', () => {
  for (const literal of [
    "'one\r\ntwo'",
    '"one\r\ntwo"',
    '`one\r\ntwo`',
    '[one\r\ntwo]',
    "'one''quoted\r\ntwo'",
    '"one""quoted\r\ntwo"',
  ]) {
    const a = Buffer.from('SELECT ' + literal + ';\r\n'),
      b = Buffer.from('SELECT ' + literal.replaceAll('\r\n', '\n') + ';\n');
    expect(sqlMigrationChecksumMatches(a, hash(b), 'x', aliases)).toBe(false);
    expect(sqlMigrationChecksumMatches(b, hash(a), 'x', aliases)).toBe(false);
    expect(sqlMigrationChecksum(a)).toBe(
      hash(Buffer.from('SELECT ' + literal + ';\n')),
    );
  }
});
it('normalizes comment line endings without interpreting their quote-like text as SQL literals', () => {
  const a = Buffer.from(
    "-- 'not a literal\r\n/* \" nor this\r\n*/ SELECT 'same';\r\n",
  );
  expect(sqlMigrationChecksum(a)).toBe(
    hash(Buffer.from(a.toString().replaceAll('\r\n', '\n'))),
  );
});
it('preserves bare CR and non-UTF8 bytes rather than changing decoded SQL content', () => {
  const a = Buffer.from([83, 69, 76, 69, 67, 84, 32, 255, 59, 13]);
  expect(sqlMigrationChecksum(a)).toBe(hash(a));
  expect(
    sqlMigrationChecksumMatches(
      a,
      hash(Buffer.from(a.toString('utf8'))),
      'x',
      aliases,
    ),
  ).toBe(false);
});
it('does not guess unaudited mixed layouts or accept malformed aliases', () => {
  const mixed = Buffer.from(lf.toString().replace('\n', '\r\n'));
  expect(sqlMigrationChecksumMatches(lf, hash(mixed), 'x', aliases)).toBe(
    false,
  );
  for (const changed of [
    { version: 2, migrations: {} },
    {
      version: 1,
      migrations: {
        x: { canonicalSha256: hash(lf), legacySha256: hash(mixed) },
      },
    },
    {
      version: 1,
      migrations: {
        x: { canonicalSha256: '0'.repeat(64), legacySha256: [hash(mixed)] },
      },
    },
  ])
    expect(sqlMigrationChecksumMatches(lf, hash(mixed), 'x', changed)).toBe(
      false,
    );
});
it('makes every historical working copy and clean Git SQL version share the same canonical content', () => {
  const entries = JSON.parse(
    readFileSync('drizzle/meta/_journal.json', 'utf8'),
  ).entries;
  for (const e of entries) {
    const p = 'drizzle/' + e.tag + '.sql',
      working = readFileSync(p),
      git = execFileSync('git', ['show', 'HEAD:' + p]);
    expect(sqlMigrationChecksum(working), e.tag).toBe(hash(git));
    expect(
      sqlMigrationChecksumMatches(git, hash(working), e.tag, aliases),
      e.tag,
    ).toBe(true);
  }
});
it('runs the actual migration command from an isolated clean-LF source copy into a disposable local database', async () => {
  const root = mkdtempSync(resolve('work/migration-portability-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'drizzle/meta'), { recursive: true });
  for (const file of ['migrate-turso.mjs', 'migration-checksums.mjs'])
    copyFileSync(resolve('scripts', file), join(root, 'scripts', file));
  const journal = execFileSync('git', [
    'show',
    'HEAD:drizzle/meta/_journal.json',
  ]);
  writeFileSync(join(root, 'drizzle/meta/_journal.json'), journal);
  copyFileSync(
    resolve('drizzle/meta/sql-checksum-aliases.json'),
    join(root, 'drizzle/meta/sql-checksum-aliases.json'),
  );
  const entries = JSON.parse(journal.toString()).entries;
  for (const e of entries)
    writeFileSync(
      join(root, 'drizzle', e.tag + '.sql'),
      execFileSync('git', ['show', 'HEAD:drizzle/' + e.tag + '.sql']),
    );
  const dbPath = join(root, 'fresh.db'),
    run = spawnSync(
      process.execPath,
      [join(root, 'scripts/migrate-turso.mjs'), '--local', dbPath],
      { encoding: 'utf8', timeout: 60000 },
    );
  expect(run.stderr).toBe('');
  expect(run.status, run.stdout).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({
    mode: '--local',
    migrations: entries.length,
    newlyApplied: entries.length,
    passed: true,
  });
  const db = createClient({ url: 'file:' + dbPath });
  try {
    const rows = (
      await db.execute(
        'SELECT idx,tag,sha256 FROM bundle_migration_ledger ORDER BY idx',
      )
    ).rows;
    expect(rows).toHaveLength(entries.length);
    for (const [i, e] of entries.entries())
      expect(rows[i]).toMatchObject({
        idx: i,
        tag: e.tag,
        sha256: sqlMigrationChecksum(
          readFileSync(join(root, 'drizzle', e.tag + '.sql')),
        ),
      });
  } finally {
    db.close();
  }
}, 60000);
