import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';

/** Storage primitives on every unmodified migration. No API admission, real
 * signed receipt, provider, execution authorization or funded proof is implied. */
const databases: DatabaseSync[] = [];
function fixture() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec('PRAGMA foreign_keys=ON');
  const journal = JSON.parse(
    readFileSync('drizzle/meta/_journal.json', 'utf8'),
  ) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries)
    db.exec(readFileSync(`drizzle/${tag}.sql`, 'utf8'));
  return db;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function reserveSwap(
  db: DatabaseSync,
  scope: 'warmup' | 'imported' = 'warmup',
  owner = 'owner',
  wallet = 'synthetic-wallet',
  intentId = `${scope}-intent`,
) {
  db.prepare('INSERT INTO solana_swap_reservations VALUES(?,?,?,?,?)').run(
    owner,
    wallet,
    scope,
    intentId,
    'awaiting_signature',
  );
}
function withdrawal(db: DatabaseSync, id = 'withdrawal') {
  db.prepare(`INSERT INTO native_withdrawals
    (id,owner_id,wallet_address,wallet_revision,document,state,created_at,updated_at)
    VALUES(?,'owner','synthetic-wallet',1,'{}','awaiting_signature',?,?)`).run(
    id,
    '2000-01-01T00:00:00.000Z',
    '2000-01-01T00:00:00.000Z',
  );
}
function reservations(db: DatabaseSync) {
  return db
    .prepare(
      'SELECT owner_id,wallet_address,scope,intent_id,state FROM solana_execution_reservations ORDER BY owner_id,wallet_address',
    )
    .all();
}
it.each(['warmup', 'imported'] as const)(
  'bridges a %s registry hold into the execution mutex and rejects a competing withdrawal atomically',
  (scope) => {
    const db = fixture();
    reserveSwap(db, scope);
    const before = reservations(db);
    expect(before).toEqual([
      {
        owner_id: 'owner',
        wallet_address: 'synthetic-wallet',
        scope,
        intent_id: `${scope}-intent`,
        state: 'awaiting_signature',
      },
    ]);
    expect(() => withdrawal(db)).toThrow('Wallet already reserved');
    expect(reservations(db)).toEqual(before);
    expect(db.prepare('SELECT * FROM native_withdrawals').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM native_withdrawal_events').all()).toEqual(
      [],
    );
  },
);
it.each(['warmup', 'imported'] as const)(
  'refuses a %s registry hold after a withdrawal without leaving a partial swap row',
  (scope) => {
    const db = fixture();
    withdrawal(db);
    const before = reservations(db);
    expect(before).toHaveLength(1);
    expect(() => reserveSwap(db, scope)).toThrow('Wallet already reserved');
    expect(reservations(db)).toEqual(before);
    expect(db.prepare('SELECT * FROM solana_swap_reservations').all()).toEqual(
      [],
    );
  },
);
it('keeps different owners and different wallets distinct while excluding the same owned wallet', () => {
  const db = fixture();
  reserveSwap(db);
  reserveSwap(db, 'imported', 'other-owner');
  reserveSwap(db, 'imported', 'owner', 'other-wallet');
  expect(reservations(db)).toHaveLength(3);
  expect(() =>
    reserveSwap(db, 'imported', 'owner', 'synthetic-wallet', 'distinct-intent'),
  ).toThrow('Wallet already reserved');
  expect(reservations(db)).toHaveLength(3);
});

function parentIntent(db: DatabaseSync, scope: 'warmup' | 'imported') {
  const table =
    scope === 'warmup'
      ? 'warmup_signing_intents'
      : 'imported_swap_signing_intents';
  if (scope === 'warmup')
    db.exec(`INSERT INTO warmup_swap_preparations
      (id,owner_id,plan_id,plan_revision,cycle,wallet_address,wallet_revision,document,created_at)
      VALUES('parent-prep','owner','synthetic-plan',1,1,'synthetic-wallet',1,'{}','2000-01-01T00:00:00.000Z')`);
  else
    db.exec(`INSERT INTO imported_swap_preparations
      (id,owner_id,project_id,project_revision,wallet_address,wallet_revision,document,created_at)
      VALUES('parent-prep','owner','synthetic-project',1,'synthetic-wallet',1,'{}','2000-01-01T00:00:00.000Z')`);
  // Minimal SQL-valid lineage, not a valid server-reviewed preparation.
  db.exec(`INSERT INTO ${table}
    (id,owner_id,preparation_id,wallet_address,document,state,created_at,updated_at)
    VALUES('parent-intent','owner','parent-prep','synthetic-wallet','{}','awaiting_signature','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z')`);
  return table;
}
it.each(['warmup', 'imported'] as const)(
  'checks %s parent insert, state propagation, guarded reactivation and deletion on the real schema',
  (scope) => {
    const db = fixture();
    const table = parentIntent(db, scope);
    expect(reservations(db)[0]).toMatchObject({
      scope,
      intent_id: 'parent-intent',
      state: 'awaiting_signature',
    });
    db.exec(`UPDATE ${table} SET state='signed',signature='parent-signature'`);
    expect(reservations(db)[0].state).toBe('signed');
    expect(
      db
        .prepare('SELECT scope,intent_id FROM solana_execution_signatures')
        .all(),
    ).toEqual([{ scope, intent_id: 'parent-intent' }]);
    db.exec(`UPDATE ${table} SET state='submitted'`);
    expect(reservations(db)[0].state).toBe('submitted');
    // Existing parent SQL permits this transition. That does not establish
    // that an API accepts it, or make it safe for a future unknown outcome.
    db.exec(`UPDATE ${table} SET state='failed'`);
    expect(reservations(db)).toEqual([]);
    withdrawal(db);
    expect(() =>
      db.exec(`UPDATE ${table} SET state='awaiting_signature'`),
    ).toThrow('Wallet already reserved');
    expect(db.prepare(`SELECT state FROM ${table}`).get()).toEqual({
      state: 'failed',
    });
    db.exec("UPDATE native_withdrawals SET state='cancelled'");
    db.exec(`UPDATE ${table} SET state='awaiting_signature'`);
    expect(reservations(db)[0].intent_id).toBe('parent-intent');
    db.exec(`DELETE FROM ${table}`);
    expect(reservations(db)).toEqual([]);
    expect(
      db.prepare('SELECT signature FROM solana_execution_signatures').all(),
    ).toEqual([{ signature: 'parent-signature' }]);
  },
);
it.each(['warmup', 'imported'] as const)(
  'refuses a %s parent intent against an existing withdrawal without recording events',
  (scope) => {
    const db = fixture();
    withdrawal(db);
    expect(() => parentIntent(db, scope)).toThrow('Wallet already reserved');
    const events =
      scope === 'warmup'
        ? 'warmup_signing_events'
        : 'imported_swap_signing_events';
    expect(db.prepare(`SELECT * FROM ${events}`).all()).toEqual([]);
    expect(reservations(db)[0].scope).toBe('withdrawal');
    expect(db.prepare('SELECT * FROM solana_swap_reservations').all()).toEqual(
      [],
    );
  },
);
it('rejects the same owned signature across warmup and imported registries', () => {
  const db = fixture();
  db.exec(
    "INSERT INTO solana_swap_signatures VALUES('owner','same-signature','warmup','first-intent')",
  );
  expect(() =>
    db.exec(
      "INSERT INTO solana_swap_signatures VALUES('owner','same-signature','imported','second-intent')",
    ),
  ).toThrow('Signature already registered');
  expect(db.prepare('SELECT scope FROM solana_swap_signatures').all()).toEqual([
    { scope: 'warmup' },
  ]);
  expect(
    db.prepare('SELECT scope FROM solana_execution_signatures').all(),
  ).toEqual([{ scope: 'warmup' }]);
});
it('propagates swap state and explicit registry deletion without treating the registry as an immutable execution journal', () => {
  const db = fixture();
  reserveSwap(db);
  db.exec("UPDATE solana_swap_reservations SET state='signed'");
  expect(reservations(db)[0].state).toBe('signed');
  db.exec("UPDATE solana_swap_reservations SET state='submitted'");
  expect(reservations(db)[0].state).toBe('submitted');
  db.exec('DELETE FROM solana_swap_reservations');
  expect(reservations(db)).toEqual([]);
  // Privileged SQL can remove this registry row. Future unresolved execution
  // holds need their own guarded lifecycle, not an assumption of immutability.
});
it('retains an old signed or submitted withdrawal until an explicit state transition', () => {
  const db = fixture();
  withdrawal(db);
  db.exec("UPDATE native_withdrawals SET state='signing'");
  db.exec(
    "UPDATE native_withdrawals SET state='signed',signature='synthetic-signature'",
  );
  expect(reservations(db)[0].state).toBe('signed');
  db.exec("UPDATE native_withdrawals SET state='submitted'");
  expect(reservations(db)[0].state).toBe('submitted');
  expect(() => reserveSwap(db)).toThrow('Wallet already reserved');
  expect(() =>
    db.exec("UPDATE native_withdrawals SET state='cancelled'"),
  ).toThrow();
  expect(reservations(db)[0].state).toBe('submitted');
});
it('records that the existing failed-withdrawal transition releases its mutex without proving non-landing', () => {
  const db = fixture();
  withdrawal(db);
  db.exec("UPDATE native_withdrawals SET state='signing'");
  db.exec(
    "UPDATE native_withdrawals SET state='signed',signature='synthetic-signature'",
  );
  db.exec("UPDATE native_withdrawals SET state='failed'");
  expect(reservations(db)).toEqual([]);
  expect(
    db.prepare('SELECT state,failure_receipt FROM native_withdrawals').get(),
  ).toEqual({ state: 'failed', failure_receipt: null });
  // This is an observed storage contract, not permission to mark an unknown
  // warmup packet failed or release its future hold without verified evidence.
});
it.each(['warmup', 'imported'] as const)(
  'registers %s signatures in the common registry and rolls back a duplicate withdrawal signature',
  (scope) => {
    const db = fixture();
    db.prepare('INSERT INTO solana_swap_signatures VALUES(?,?,?,?)').run(
      'owner',
      'synthetic-signature',
      scope,
      'swap-intent',
    );
    expect(
      db.prepare('SELECT * FROM solana_execution_signatures').all(),
    ).toEqual([
      {
        owner_id: 'owner',
        signature: 'synthetic-signature',
        scope,
        intent_id: 'swap-intent',
      },
    ]);
    withdrawal(db);
    db.exec("UPDATE native_withdrawals SET state='signing'");
    expect(() =>
      db.exec(
        "UPDATE native_withdrawals SET state='signed',signature='synthetic-signature'",
      ),
    ).toThrow('Signature already registered');
    expect(
      db.prepare('SELECT state,signature FROM native_withdrawals').get(),
    ).toEqual({ state: 'signing', signature: null });
    expect(reservations(db)[0].state).toBe('signing');
  },
);
it('rejects a swap signature already registered by a withdrawal and keeps both registries unchanged', () => {
  const db = fixture();
  withdrawal(db);
  db.exec("UPDATE native_withdrawals SET state='signing'");
  db.exec(
    "UPDATE native_withdrawals SET state='signed',signature='synthetic-signature'",
  );
  const before = db.prepare('SELECT * FROM solana_execution_signatures').all();
  expect(before).toHaveLength(1);
  expect(() =>
    db
      .prepare('INSERT INTO solana_swap_signatures VALUES(?,?,?,?)')
      .run('owner', 'synthetic-signature', 'warmup', 'swap-intent'),
  ).toThrow('Signature already registered');
  expect(db.prepare('SELECT * FROM solana_swap_signatures').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM solana_execution_signatures').all()).toEqual(
    before,
  );
  expect(db.prepare('PRAGMA integrity_check').get()).toEqual({
    integrity_check: 'ok',
  });
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
