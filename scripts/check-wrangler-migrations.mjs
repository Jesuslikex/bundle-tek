import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Test whole files through the real CLI. Drizzle breakpoint tests miss bugs in
// Wrangler's whole-file compound-statement splitter. Never use a project DB.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const journal = JSON.parse(readFileSync(join(root, 'drizzle/meta/_journal.json'), 'utf8'));
const pkgRoot = join(root, 'node_modules/wrangler');
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
const cli = join(pkgRoot, typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.wrangler);
const scratch = mkdtempSync(join(tmpdir(), 'bundle-wrangler-migrations-'));
const migrations = join(scratch, 'migrations');
mkdirSync(migrations);
const hashes = {};
for (const entry of journal.entries) {
  const filename = `${entry.tag}.sql`;
  const bytes = readFileSync(join(root, 'drizzle', filename));
  hashes[filename] = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(migrations, filename), bytes);
}
const config = join(scratch, 'wrangler.json');
writeFileSync(config, JSON.stringify({
  name: 'bundle-disposable-migration-check', compatibility_date: '2026-09-01',
  d1_databases: [{ binding: 'DB', database_name: 'bundle-disposable-migration-check',
    database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: './migrations' }],
}, null, 2));
const args = ['d1', 'migrations', 'apply', 'DB', '--local', '--config', config,
  '--persist-to', join(scratch, 'state')];
const startedAt = new Date().toISOString();
const result = spawnSync(process.execPath, [cli, ...args], {
  cwd: scratch, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
  encoding: 'utf8', timeout: 240_000, maxBuffer: 8 * 1024 * 1024,
});
writeFileSync(join(scratch, 'apply.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
let ledger = null;
let ledgerExit = null;
if (result.status === 0) {
  const query = spawnSync(process.execPath, [cli, 'd1', 'execute', 'DB', '--local',
    '--config', config, '--persist-to', join(scratch, 'state'), '--json', '--command',
    'SELECT name FROM d1_migrations ORDER BY name'], {
    cwd: scratch, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
    encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  ledgerExit = query.status;
  writeFileSync(join(scratch, 'ledger.log'), `${query.stdout ?? ''}\n${query.stderr ?? ''}`);
  if (query.status === 0) {
    ledger = JSON.parse(query.stdout)[0].results.map((row) => row.name);
  }
}
const expected = journal.entries.map((entry) => `${entry.tag}.sql`).sort();
const passed = result.status === 0 && ledgerExit === 0 &&
  JSON.stringify(ledger) === JSON.stringify(expected);
const report = { startedAt, finishedAt: new Date().toISOString(), wranglerVersion: pkg.version,
  scratch, command: [process.execPath, cli, ...args], sourceHashes: hashes,
  migrationCount: expected.length, applyExit: result.status, ledgerExit,
  appliedCount: ledger?.length ?? null, passed, error: result.error?.message ?? null };
writeFileSync(join(scratch, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ scratch, migrationCount: expected.length,
  appliedCount: report.appliedCount, applyExit: result.status, passed }));
// Retain disposable state and logs for review; no application files are written.
process.exitCode = passed ? 0 : 1;
