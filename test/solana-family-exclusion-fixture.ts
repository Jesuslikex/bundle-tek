import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export const exclusionWallet = 'synthetic-storage-wallet';
export const exclusionOwner = 'storage-owner';
const old = '2000-01-01T00:00:00.000Z';
const clocks = new WeakMap<DatabaseSync, { now: number }>();

/** Unchanged full production schema; SQL-valid storage parents only.
 * No HTTP admission, valid packet/signature, provider or financial proof. */
export function solanaFamilyExclusionFixture(maxMigration = 137) {
  const db = new DatabaseSync(':memory:');
  const clock = { now: Date.now() };
  clocks.set(db, clock);
  db.function('strftime', { varargs: true }, (format, ...args) => {
    let time = args[0] === 'now' ? clock.now : Date.parse(String(args[0]));
    for (const modifier of args.slice(1)) {
      const match = /^\+(\d+) (days|seconds)$/.exec(String(modifier));
      if (!match) throw Error('Unsupported exclusion-fixture clock modifier');
      time += Number(match[1]) * (match[2] === 'days' ? 86400000 : 1000);
    }
    if (!Number.isFinite(time)) return null;
    if (format === '%s') return String(Math.floor(time / 1000));
    if (format !== '%Y-%m-%dT%H:%M:%fZ')
      throw Error('Unsupported exclusion-fixture clock format');
    return new Date(time).toISOString();
  });
  db.exec('PRAGMA foreign_keys=ON');
  const journal = JSON.parse(
    readFileSync('drizzle/meta/_journal.json', 'utf8'),
  ) as {
    entries: { idx: number; tag: string }[];
  };
  for (const { idx, tag } of journal.entries)
    if (idx <= maxMigration)
      db.exec(readFileSync(`drizzle/${tag}.sql`, 'utf8'));
  return db;
}

/** Minimal async D1 facade for exercising the actual read/prepare HTTP handler. */
export function familyExclusionD1(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...args: SQLInputValue[]) {
          values = args;
          return statement;
        },
        async first() {
          return sqlite.prepare(sql).get(...values) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...values) };
        },
        async run() {
          const r = sqlite.prepare(sql).run(...values);
          return { meta: { changes: Number(r.changes) } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

export function familyWithdrawal(
  db: DatabaseSync,
  wallet = exclusionWallet,
  owner = exclusionOwner,
  id = 'withdrawal',
) {
  db.prepare(`INSERT INTO native_withdrawals
    (id,owner_id,wallet_address,wallet_revision,document,state,created_at,updated_at)
    VALUES(?,?,?,1,'{}','awaiting_signature',?,?)`).run(
    id,
    owner,
    wallet,
    old,
    old,
  );
}

export type ExclusionFamily = 'cleanup' | 'supply' | 'organic' | 'volume';
export const exclusionFamilies: ExclusionFamily[] = [
  'cleanup',
  'supply',
  'organic',
  'volume',
];
export const familyTables = {
  cleanup: 'wallet_cleanups',
  supply: 'token_supply_actions',
  organic: 'pump_organic_sequences',
  volume: 'volume_bot_sessions',
} as const;

export function reserveFamily(
  db: DatabaseSync,
  family: ExclusionFamily,
  wallet = exclusionWallet,
  owner = exclusionOwner,
  suffix = '',
  extraWallet?: string,
) {
  const id = `${family}-${owner}${suffix}`;
  const wallets = extraWallet ? [wallet, extraWallet] : [wallet];
  switch (family) {
    case 'cleanup':
      db.prepare(`INSERT INTO wallet_cleanups
        (id,owner_id,batch_id,wallet_address,wallet_revision,destination,document,state,created_at,updated_at)
        VALUES(?,?,?,?,1,'synthetic-destination',?,'awaiting_signature',?,?)`).run(
        id,
        owner,
        'cleanup-batch',
        wallet,
        JSON.stringify({ format: 'wallet-cleanup-v1' }),
        old,
        old,
      );
      break;
    case 'supply':
      db.prepare(`INSERT INTO token_supply_actions
        (id,owner_id,wallet_address,wallet_revision,kind,mint,document,state,created_at,updated_at)
        VALUES(?,?,?,1,'burn','synthetic-mint',?,'awaiting_signature',?,?)`).run(
        id,
        owner,
        wallet,
        JSON.stringify({ id, kind: 'burn', mint: 'synthetic-mint', wallet }),
        old,
        old,
      );
      break;
    case 'organic':
      db.prepare(`INSERT INTO pump_organic_sequences
        (id,owner_id,project_id,launch_review_id,mint,rent_allowance_raw,plan,plan_sha256,state,created_at)
        VALUES(?,?,'project','launch','synthetic-mint','1',?,?,'active',?)`).run(
        id,
        owner,
        JSON.stringify({ rows: wallets.map((address) => ({ address })) }),
        'a'.repeat(64),
        old,
      );
      break;
    case 'volume':
      db.prepare(`INSERT INTO volume_bot_sessions
        (id,owner_id,project_id,project_revision,mint,decimals,plan,plan_sha256,state,created_at)
        VALUES(?,?,'project',1,'synthetic-mint',6,?,?,'active',?)`).run(
        id,
        owner,
        JSON.stringify({ format: 'volume-bot-plan-v1', wallets }),
        'a'.repeat(64),
        old,
      );
  }
  return id;
}

/** Follow real allowed storage transitions. Markers are not valid signatures. */
export function signFamily(
  db: DatabaseSync,
  family: 'cleanup' | 'supply',
  submitted = false,
) {
  const table = familyTables[family],
    id = `${family}-${exclusionOwner}`;
  db.prepare(`UPDATE ${table} SET state='signing' WHERE id=?`).run(id);
  db.prepare(`UPDATE ${table} SET state='signed',signature=? WHERE id=?`).run(
    `${family}-synthetic-signature`,
    id,
  );
  if (submitted)
    db.prepare(`UPDATE ${table} SET state='submitted' WHERE id=?`).run(id);
}

export function stopFamily(db: DatabaseSync, family: ExclusionFamily) {
  const state = family === 'organic' ? 'stopped' : 'cancelled';
  db.prepare(`UPDATE ${familyTables[family]} SET state=? WHERE id=?`).run(
    state,
    `${family}-${exclusionOwner}`,
  );
}

export function unresolvedScheduledTrade(
  db: DatabaseSync,
  family: 'organic' | 'volume',
  state: 'signed' | 'submitting' | 'submitted',
  expire = true,
) {
  const id = `${family}-${exclusionOwner}`,
    batch = `${family}-batch`;
  const organic = family === 'organic';
  const batches = organic ? 'pump_organic_batches' : 'volume_bot_batches';
  const parent = organic ? 'sequence_id' : 'session_id';
  // Starts unexpired so the real send guard can be crossed. No network send.
  const expiry = new Date(clocks.get(db)!.now + 3600_000).toISOString();
  db.prepare(`INSERT INTO ${batches}(id,owner_id,${parent},batch,review,review_sha256,state,expires_at)
    VALUES(?,?,?,0,'{}',?,'signed',?)`).run(
    batch,
    exclusionOwner,
    id,
    'b'.repeat(64),
    expiry,
  );
  const trades = organic ? 'pump_organic_buys' : 'volume_bot_trades';
  if (organic)
    db.prepare(`INSERT INTO pump_organic_buys(owner_id,batch_id,buy_index,holder,signed,signature,state)
      VALUES(?,?,0,?,'synthetic-packet','organic-synthetic-signature','signed')`).run(
      exclusionOwner,
      batch,
      exclusionWallet,
    );
  else
    db.prepare(`INSERT INTO volume_bot_trades(owner_id,batch_id,trade_index,round,side,wallet,signed,signature,state)
      VALUES(?,?,0,0,'Buy',?,'synthetic-packet','volume-synthetic-signature','signed')`).run(
      exclusionOwner,
      batch,
      exclusionWallet,
    );
  if (state !== 'signed')
    db.prepare(`UPDATE ${trades} SET state='submitting' WHERE batch_id=?`).run(
      batch,
    );
  if (state === 'submitted')
    db.prepare(`UPDATE ${trades} SET state='submitted' WHERE batch_id=?`).run(
      batch,
    );
  // Let time pass; the real guards forbid rewriting a batch's original expiry.
  if (!expire) return;
  clocks.get(db)!.now += 7200_000;
  if (
    (
      db
        .prepare(
          `SELECT expires_at<strftime('%Y-%m-%dT%H:%M:%fZ','now') AS expired FROM ${batches} WHERE id=?`,
        )
        .get(batch) as { expired: number }
    ).expired !== 1
  )
    throw Error('Synthetic clock did not cross the original batch expiry');
}
