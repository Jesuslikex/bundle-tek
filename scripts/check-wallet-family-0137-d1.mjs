// Local-only 0136-to-0137 upgrade/guard probe. Run from the Bundle checkout.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const scratch = mkdtempSync(join(tmpdir(), 'bundle-family-runtime-d1-')),
  migrations = join(scratch, 'migrations');
mkdirSync(migrations);
const journal = JSON.parse(
  readFileSync('drizzle/meta/_journal.json', 'utf8'),
).entries;
for (const e of journal.filter((e) => e.idx < 137))
  copyFileSync('drizzle/' + e.tag + '.sql', join(migrations, e.tag + '.sql'));
const config = join(scratch, 'wrangler.json');
writeFileSync(
  config,
  JSON.stringify({
    name: 'bundle-family-runtime-only',
    compatibility_date: '2026-09-01',
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'bundle-family-runtime-only',
        database_id: '00000000-0000-0000-0000-000000000000',
        migrations_dir: './migrations',
      },
    ],
  }),
);
const pkg = JSON.parse(
  readFileSync('node_modules/wrangler/package.json', 'utf8'),
);
const cli = resolve(
  'node_modules/wrangler',
  typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.wrangler,
);
const common = [
  'DB',
  '--local',
  '--config',
  config,
  '--persist-to',
  join(scratch, 'state'),
];
const results = [];
let completed = false;
function execute(name, args, refusal) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: scratch,
    encoding: 'utf8',
    timeout: 240000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
  });
  writeFileSync(
    join(scratch, name.replace(/[^a-z0-9]+/gi, '-') + '.log'),
    (r.stdout ?? '') + '\n' + (r.stderr ?? ''),
  );
  const passed = refusal
    ? r.status !== 0 && refusal.test(r.stdout + r.stderr)
    : r.status === 0;
  results.push({
    name,
    passed,
    exit: r.status,
    expectedRefusal: refusal?.source ?? null,
  });
  if (!passed)
    throw Error(
      name +
        ' failed: ' +
        (r.stderr || r.stdout || r.error?.message || 'no tool output').slice(
          -1000,
        ),
    );
  return r.stdout;
}
const quote = (v) => "'" + String(v).replaceAll("'", "''") + "'";
const json = (v) => quote(JSON.stringify(v));
const owner = 'runtime-d1';
const old = '2000-01-01T00:00:00.000Z';
const future = '2030-01-01T00:00:00.000Z';
const c = (id, w) =>
  `INSERT INTO wallet_cleanups(id,owner_id,batch_id,wallet_address,wallet_revision,destination,document,state,created_at,updated_at) VALUES(${quote(id)},'${owner}',${quote(id + '-batch')},${quote(w)},1,'dest','{"format":"wallet-cleanup-v1"}','awaiting_signature','${old}','${old}');`;
const s = (id, w) =>
  `INSERT INTO token_supply_actions(id,owner_id,wallet_address,wallet_revision,kind,mint,document,state,created_at,updated_at) VALUES(${quote(id)},'${owner}',${quote(w)},1,'burn','mint',${json({ id, kind: 'burn', mint: 'mint', wallet: w })},'awaiting_signature','${old}','${old}');`;
const parent = (f, id, w, state = 'active') =>
  f === 'organic'
    ? `INSERT INTO pump_organic_sequences(id,owner_id,project_id,launch_review_id,mint,rent_allowance_raw,plan,plan_sha256,state) VALUES(${quote(id)},'${owner}','project','launch','mint','1',${json({ rows: [{ address: w }] })},'${'a'.repeat(64)}',${quote(state)});`
    : `INSERT INTO volume_bot_sessions(id,owner_id,project_id,project_revision,mint,decimals,plan,plan_sha256,state) VALUES(${quote(id)},'${owner}','project',1,'mint',6,${json({ format: 'volume-bot-plan-v1', wallets: [w] })},'${'a'.repeat(64)}',${quote(state)});`;
const batch = (f, id, parentId) =>
  `INSERT INTO ${f === 'organic' ? 'pump_organic_batches' : 'volume_bot_batches'}(id,owner_id,${f === 'organic' ? 'sequence_id' : 'session_id'},batch,review,review_sha256,state,expires_at) VALUES(${quote(id)},'${owner}',${quote(parentId)},0,'{}','${'b'.repeat(64)}','signed','${future}');`;
const trade = (f, b, w, sig) =>
  f === 'organic'
    ? `INSERT INTO pump_organic_buys(owner_id,batch_id,buy_index,holder,signed,signature,state) VALUES('${owner}',${quote(b)},0,${quote(w)},'synthetic',${quote(sig)},'signed');`
    : `INSERT INTO volume_bot_trades(owner_id,batch_id,trade_index,round,side,wallet,signed,signature,state) VALUES('${owner}',${quote(b)},0,0,'Buy',${quote(w)},'synthetic',${quote(sig)},'signed');`;
const q = (name, sql, refusal) =>
  execute(
    name,
    ['d1', 'execute', ...common, '--json', '--command', sql],
    refusal,
  );
try {
  execute('apply baseline137', ['d1', 'migrations', 'apply', ...common]);
  const seed = [
    c('held-c', 'held-c-wallet'),
    s('held-s', 'held-s-wallet'),
    c('sign-c', 'sign-wallet'),
    s('sign-s', 'sign-wallet'),
    c('send-c', 'send-c-wallet'),
    s('send-c-other', 'send-c-wallet'),
    c('send-s-other', 'send-s-wallet'),
    s('send-s', 'send-s-wallet'),
    "UPDATE wallet_cleanups SET state='signing' WHERE id='send-c';",
    "UPDATE wallet_cleanups SET state='signed',signature='cleanup-test-signature' WHERE id='send-c';",
    "UPDATE token_supply_actions SET state='signing' WHERE id='send-s';",
    "UPDATE token_supply_actions SET state='signed',signature='supply-test-signature' WHERE id='send-s';",
    `INSERT INTO native_withdrawals(id,owner_id,wallet_address,wallet_revision,document,state,created_at,updated_at) VALUES('native','${owner}','native-original',1,'{}','awaiting_signature','${old}','${old}');`,
  ];
  for (const f of ['organic', 'volume']) {
    seed.push(
      parent(f, f + '-send', f + '-send-wallet'),
      batch(f, f + '-send-batch', f + '-send'),
      trade(f, f + '-send-batch', f + '-send-wallet', f + '-send-signature'),
      c(f + '-send-c', f + '-send-wallet'),
    );
    seed.push(
      parent(f, f + '-batch-parent', f + '-batch-wallet'),
      c(f + '-batch-c', f + '-batch-wallet'),
    );
    seed.push(
      parent(f, f + '-member-parent', f + '-member-wallet'),
      batch(f, f + '-member-batch', f + '-member-parent'),
    );
    seed.push(
      parent(
        f,
        f + '-stopped',
        f + '-stopped-wallet',
        f === 'organic' ? 'stopped' : 'cancelled',
      ),
    );
  }
  const seedFile = join(scratch, 'legacy-seed.sql');
  writeFileSync(seedFile, seed.join('\n'));
  execute('seed legacy conflicts', [
    'd1',
    'execute',
    ...common,
    '--file',
    seedFile,
    '--json',
  ]);
  copyFileSync(
    'drizzle/0137_solana_wallet_family_exclusion.sql',
    join(migrations, '0137_solana_wallet_family_exclusion.sql'),
  );
  execute('upgrade to138', ['d1', 'migrations', 'apply', ...common]);
  q('cleanup insert', c('new-c', 'held-s-wallet'), /already reserved/);
  q('supply insert', s('new-s', 'held-c-wallet'), /already reserved/);
  q(
    'organic insert',
    parent('organic', 'new-o', 'held-c-wallet'),
    /already reserved/,
  );
  q(
    'volume insert',
    parent('volume', 'new-v', 'held-c-wallet'),
    /already reserved/,
  );
  q(
    'shared identity update',
    `UPDATE solana_execution_reservations SET wallet_address='held-c-wallet' WHERE owner_id='${owner}'`,
    /already reserved/,
  );
  q(
    'cleanup signing',
    "UPDATE wallet_cleanups SET state='signing' WHERE id='sign-c'",
    /already reserved/,
  );
  q(
    'supply signing',
    "UPDATE token_supply_actions SET state='signing' WHERE id='sign-s'",
    /already reserved/,
  );
  q(
    'cleanup sending',
    "UPDATE wallet_cleanups SET state='submitted' WHERE id='send-c'",
    /already reserved/,
  );
  q(
    'supply sending',
    "UPDATE token_supply_actions SET state='submitted' WHERE id='send-s'",
    /already reserved/,
  );
  for (const f of ['organic', 'volume']) {
    const parents =
        f === 'organic' ? 'pump_organic_sequences' : 'volume_bot_sessions',
      trades = f === 'organic' ? 'pump_organic_buys' : 'volume_bot_trades';
    q(
      f + ' reactivate',
      `UPDATE ${parents} SET state='active' WHERE id='${f}-stopped'`,
      /cannot be reactivated/,
    );
    q(
      f + ' send',
      `UPDATE ${trades} SET state='submitting' WHERE batch_id='${f}-send-batch'`,
      /already reserved/,
    );
    q(
      f + ' identity',
      `UPDATE ${parents} SET id='replacement' WHERE id='${f}-member-parent'`,
      /immutable/,
    );
    q(
      f + ' batch',
      batch(f, 'new-' + f + '-batch', f + '-batch-parent'),
      /already reserved/,
    );
    q(
      f + ' member',
      trade(f, f + '-member-batch', 'outside-wallet', f + '-outside-signature'),
      /differs/,
    );
  }
  const ledger = JSON.parse(
    q('final ledger', 'SELECT count(*) AS n FROM d1_migrations'),
  )[0].results[0].n;
  if (ledger !== 138) throw Error('Wrong final migration count');
  completed = true;
} finally {
  writeFileSync(
    join(scratch, 'runtime-report.json'),
    JSON.stringify(
      {
        scratch,
        syntheticStorageOnly: true,
        results,
        passed:
          completed && results.length === 23 && results.every((r) => r.passed),
      },
      null,
      2,
    ),
  );
}
console.log(
  JSON.stringify({
    scratch,
    report: join(scratch, 'runtime-report.json'),
    scenarios: results.length,
    passed:
      completed && results.length === 23 && results.every((r) => r.passed),
  }),
);
if (!completed || results.length !== 23 || !results.every((r) => r.passed))
  process.exitCode = 1;
