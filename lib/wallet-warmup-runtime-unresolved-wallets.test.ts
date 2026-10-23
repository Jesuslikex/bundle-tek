import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { WARMUP_RUNTIME_UNRESOLVED_WALLETS_SQL as unresolved } from './wallet-warmup-runtime-unresolved-wallets';
import { WARMUP_RUNTIME_WALLET_BUSY_SQL as originalBusy } from './wallet-warmup-runtime-wallet-busy';

type Family = 'volume' | 'organic';
type State =
  | 'signed'
  | 'submitting'
  | 'submitted'
  | 'finalized'
  | 'failed'
  | 'expired'
  | 'cancelled';
const entries = (
  JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
    entries: { tag: string }[];
  }
).entries;
const boundary = entries.findIndex((e) => e.tag.startsWith('0137_'));
if (boundary < 1 || !entries.some((e) => e.tag.startsWith('0140_')))
  throw Error('Actual migration chain through0140 required.');
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function apply(db: DatabaseSync, from = 0, to = entries.length) {
  for (const { tag } of entries.slice(from, to))
    for (const statement of readFileSync(`drizzle/${tag}.sql`, 'utf8').split(
      '--> statement-breakpoint',
    ))
      if (statement.trim()) db.exec(statement);
}
function database(legacy = false) {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec('PRAGMA foreign_keys=ON');
  apply(db, 0, legacy ? boundary : entries.length);
  return db;
}
function parent(
  db: DatabaseSync,
  family: Family,
  owner = 'owner',
  roster = 'selected',
) {
  if (family === 'volume')
    db.prepare(
      'INSERT INTO volume_bot_sessions(id,owner_id,project_id,project_revision,mint,decimals,plan,plan_sha256,state) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      'parent',
      owner,
      'project',
      1,
      'mint',
      6,
      JSON.stringify({ format: 'volume-bot-plan-v1', wallets: [roster] }),
      '0'.repeat(64),
      'active',
    );
  else
    db.prepare(
      'INSERT INTO pump_organic_sequences(id,owner_id,project_id,launch_review_id,mint,rent_allowance_raw,plan,plan_sha256,state) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      'parent',
      owner,
      'project',
      'launch',
      'mint',
      '0',
      JSON.stringify({ rows: [{ address: roster }] }),
      '0'.repeat(64),
      'active',
    );
  const table =
      family === 'volume' ? 'volume_bot_batches' : 'pump_organic_batches',
    column = family === 'volume' ? 'session_id' : 'sequence_id';
  db.prepare(
    `INSERT INTO ${table}(id,owner_id,${column},batch,review,review_sha256,state,expires_at) VALUES(?,?,?,?,?,?,?,?)`,
  ).run(
    'batch',
    owner,
    'parent',
    0,
    '{}',
    '0'.repeat(64),
    'signed',
    '2099-01-01T00:00:00.000Z',
  );
}
function child(
  db: DatabaseSync,
  family: Family,
  owner = 'owner',
  wallet = 'selected',
) {
  // Synthetic packet/signature strings establish SQL state only; no signature,
  // provider execution or service-level transaction qualification is claimed.
  if (family === 'volume')
    db.prepare(
      'INSERT INTO volume_bot_trades(owner_id,batch_id,trade_index,round,side,wallet,signed,signature,state) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      owner,
      'batch',
      0,
      0,
      'Buy',
      wallet,
      'synthetic-private-packet',
      'synthetic-signature',
      'signed',
    );
  else
    db.prepare(
      'INSERT INTO pump_organic_buys(owner_id,batch_id,buy_index,holder,signed,signature,state) VALUES(?,?,?,?,?,?,?)',
    ).run(
      owner,
      'batch',
      0,
      wallet,
      'synthetic-private-packet',
      'synthetic-signature',
      'signed',
    );
}
function move(db: DatabaseSync, family: Family, state: State) {
  const table = family === 'volume' ? 'volume_bot_trades' : 'pump_organic_buys';
  if (['submitting', 'submitted', 'finalized', 'failed'].includes(state))
    db.prepare(
      `UPDATE ${table} SET state='submitting' WHERE batch_id='batch'`,
    ).run();
  if (state === 'submitted')
    db.prepare(
      `UPDATE ${table} SET state='submitted' WHERE batch_id='batch'`,
    ).run();
  else if (state !== 'signed' && state !== 'submitting')
    db.prepare(`UPDATE ${table} SET state=? WHERE batch_id='batch'`).run(state);
}
function stop(db: DatabaseSync, family: Family) {
  db.prepare(
    `UPDATE ${family === 'volume' ? 'volume_bot_sessions' : 'pump_organic_sequences'} SET state=? WHERE id='parent'`,
  ).run(family === 'volume' ? 'cancelled' : 'stopped');
}
function read(
  db: DatabaseSync,
  expression = unresolved,
  owner = 'owner',
  wallet = 'selected',
) {
  return db
    .prepare(
      `SELECT ${expression} AS busy FROM (SELECT ? AS owner_id,? AS review_document) c`,
    )
    .get(owner, JSON.stringify({ wallets: [{ wallet }] }));
}
const cases = (['volume', 'organic'] as const).flatMap((family) =>
  (['signed', 'submitting', 'submitted'] as const).map((state) => ({
    family,
    state,
  })),
);
it.each(cases)(
  'retains actual pre0137 $family/$state child-wallet discrepancy across the unchanged full migration upgrade',
  ({ family, state }) => {
    const db = database(true);
    parent(db, family, 'owner', 'other-roster-wallet');
    child(db, family); // Pre0137 has no child membership guard; no guard was dropped.
    move(db, family, state);
    stop(db, family);
    expect(read(db, originalBusy)).toEqual({ busy: 0 });
    apply(db, boundary);
    expect(read(db, originalBusy)).toEqual({ busy: 0 });
    expect(read(db)).toEqual({ busy: 1 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({
      integrity_check: 'ok',
    });
    // The additive migration guards now prevent rewriting the inherited roster.
    expect(() =>
      db
        .prepare(
          `UPDATE ${family === 'volume' ? 'volume_bot_sessions' : 'pump_organic_sequences'} SET plan=? WHERE id='parent'`,
        )
        .run(
          family === 'volume'
            ? JSON.stringify({
                format: 'volume-bot-plan-v1',
                wallets: ['selected'],
              })
            : JSON.stringify({ rows: [{ address: 'selected' }] }),
        ),
    ).toThrow(/immutable/);
  },
);
it.each(cases)(
  'keeps genuine current-schema stopped $family/$state work unavailable without weakening the original roster check',
  ({ family, state }) => {
    const db = database();
    parent(db, family);
    child(db, family);
    move(db, family, state);
    stop(db, family);
    expect(read(db, originalBusy)).toEqual({ busy: 1 });
    expect(read(db)).toEqual({ busy: 1 });
    expect(read(db, unresolved, 'other-owner')).toEqual({ busy: 0 });
    expect(read(db, unresolved, 'owner', 'unrelated-wallet')).toEqual({
      busy: 0,
    });
  },
);
it.each(['volume', 'organic'] as const)(
  'current-schema %s guards refuse roster/owner/member mutation and reactivation',
  (family) => {
    const db = database();
    parent(db, family);
    expect(() => child(db, family, 'owner', 'not-in-roster')).toThrow(
      /differs from/,
    );
    expect(() => child(db, family, 'other-owner')).toThrow(/differs from/);
    child(db, family);
    const table =
      family === 'volume' ? 'volume_bot_sessions' : 'pump_organic_sequences';
    expect(() =>
      db
        .prepare(`UPDATE ${table} SET owner_id='other-owner' WHERE id='parent'`)
        .run(),
    ).toThrow(/immutable/);
    expect(() =>
      db.prepare(`UPDATE ${table} SET plan='{}' WHERE id='parent'`).run(),
    ).toThrow(/immutable/);
    stop(db, family);
    expect(() =>
      db.prepare(`UPDATE ${table} SET state='active' WHERE id='parent'`).run(),
    ).toThrow(/cannot be reactivated/);
  },
);
it.each(['volume', 'organic'] as const)(
  'conservatively retains inherited %s child/parent owner inconsistencies for either involved owner',
  (family) => {
    const db = database(true);
    parent(db, family, 'parent-owner', 'other-roster-wallet');
    child(db, family, 'child-owner');
    move(db, family, 'submitted');
    stop(db, family);
    apply(db, boundary);
    expect(read(db, unresolved, 'parent-owner')).toEqual({ busy: 1 });
    expect(read(db, unresolved, 'child-owner')).toEqual({ busy: 1 });
    expect(read(db, unresolved, 'unrelated-owner')).toEqual({ busy: 0 });
  },
);
it.each(
  (['volume', 'organic'] as const).flatMap((family) =>
    (['finalized', 'failed', 'expired', 'cancelled'] as const).map((state) => ({
      family,
      state,
    })),
  ),
)(
  'does not turn terminal $family/$state evidence into an unresolved hold',
  ({ family, state }) => {
    const db = database();
    parent(db, family);
    child(db, family);
    move(db, family, state);
    stop(db, family);
    expect(read(db)).toEqual({ busy: 0 });
    expect(read(db, originalBusy)).toEqual({ busy: 0 });
  },
);
it.each(['volume', 'organic'] as const)(
  'leaves %s active-parent policy with no child to the unchanged original predicate',
  (family) => {
    const db = database();
    parent(db, family);
    expect(read(db)).toEqual({ busy: 0 });
    expect(read(db, originalBusy)).toEqual({ busy: 1 });
  },
);
