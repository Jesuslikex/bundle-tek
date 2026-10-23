import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { warmupExecutionLeaseFixture } from './warmup-execution-lease-fixture';
import { readWarmupExecutionWalletLease } from '../lib/wallet-warmup-execution-lease';
import {
  familyWithdrawal,
  reserveFamily,
} from './solana-family-exclusion-fixture';

const migration = readFileSync(
  'drizzle/0141_wallet_warmup_execution_wallet_leases.sql',
  'utf8',
).replace(/\r\n/g, '\n');
const previous = readFileSync(
  'drizzle/0137_solana_wallet_family_exclusion.sql',
  'utf8',
);
const otherWallet = 'unselected-synthetic-storage-wallet';
const otherOwner = 'unrelated-synthetic-owner';
const old = '2000-01-01T00:00:00.000Z';
type Fixture = Awaited<ReturnType<typeof warmupExecutionLeaseFixture>>;
type Insert = (db: DatabaseSync, wallet: string, owner: string) => void;
const direct: Record<string, Insert> = {
  central: (db, wallet, owner) => {
    db.prepare(
      "INSERT INTO solana_execution_reservations(owner_id,wallet_address,scope,intent_id,state) VALUES(?,?,'warmup','lease-control','awaiting_signature')",
    ).run(owner, wallet);
  },
  swap: (db, wallet, owner) => {
    db.prepare(
      "INSERT INTO solana_swap_reservations(owner_id,wallet_address,scope,intent_id,state) VALUES(?,?,'warmup','lease-control','awaiting_signature')",
    ).run(owner, wallet);
  },
  withdrawal: (db, wallet, owner) =>
    familyWithdrawal(db, wallet, owner, 'lease-control'),
  cleanup: (db, wallet, owner) => {
    reserveFamily(db, 'cleanup', wallet, owner);
  },
  supply: (db, wallet, owner) => {
    reserveFamily(db, 'supply', wallet, owner);
  },
  organic_parent: (db, wallet, owner) => {
    reserveFamily(db, 'organic', wallet, owner);
  },
  volume_parent: (db, wallet, owner) => {
    reserveFamily(db, 'volume', wallet, owner);
  },
  imported: (db, wallet, owner) => {
    db.prepare(
      "INSERT INTO imported_swap_preparations(id,owner_id,project_id,project_revision,wallet_address,wallet_revision,document,created_at) VALUES('lease-prep',?,'synthetic-project',1,?,1,'{}',?)",
    ).run(owner, wallet, old);
    db.prepare(
      "INSERT INTO imported_swap_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,created_at,updated_at) VALUES('lease-intent',?,'lease-prep',?,'{}','awaiting_signature',?,?)",
    ).run(owner, wallet, old, old);
  },
  warmup: (db, wallet, owner) => {
    db.prepare(
      "INSERT INTO warmup_swap_preparations(id,owner_id,plan_id,plan_revision,cycle,wallet_address,wallet_revision,document,created_at) VALUES('lease-prep',?,'synthetic-plan',1,0,?,1,'{}',?)",
    ).run(owner, wallet, old);
    db.prepare(
      "INSERT INTO warmup_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,created_at,updated_at) VALUES('lease-intent',?,'lease-prep',?,'{}','awaiting_signature',?,?)",
    ).run(owner, wallet, old, old);
  },
};

// Real unchanged full native schema and actual retained proposal/approval/root.
// Financial control rows are SQL-valid synthetic metadata, not chain receipts,
// human approvals, HTTP admission or valid signed transactions.
describe('warmup execution wallet lease exclusions on the full schema', () => {
  let f: Fixture;
  let wallet: string;
  beforeAll(async () => {
    f = await warmupExecutionLeaseFixture();
    wallet = f.proposed.terms.intent.wallets[0]!.wallet;
  });
  afterAll(() => f?.dispose());
  beforeEach(() => f.sqlite.exec('SAVEPOINT lease_case'));
  afterEach(() => {
    f.sqlite.exec('ROLLBACK TO lease_case; RELEASE lease_case');
    expect(f.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it.each(Object.entries(direct))(
    '%s: an existing valid financial row refuses a new lease',
    (_family, insert) => {
      insert(f.sqlite, wallet, f.owner);
      expect(() => f.insertLease()).toThrow(
        /Wallet already reserved|no longer current/,
      );
      expect(
        f.sqlite
          .prepare(
            'SELECT count(*) AS n FROM wallet_warmup_execution_wallet_leases',
          )
          .get()!.n,
      ).toBe(0);
    },
  );

  it.each(Object.entries(direct))(
    '%s: a retained lease refuses a new financial row',
    (_family, insert) => {
      f.insertLease();
      expect(() => insert(f.sqlite, wallet, f.owner)).toThrow(
        'Wallet held by warmup execution',
      );
      expect(
        f.sqlite
          .prepare(
            'SELECT count(*) AS n FROM wallet_warmup_execution_wallet_leases',
          )
          .get()!.n,
      ).toBe(1);
    },
  );

  it.each(Object.entries(direct))(
    '%s: unrelated owner and unselected wallet stay available',
    (_family, insert) => {
      f.insertLease();
      insert(f.sqlite, wallet, otherOwner);
      // Separate rollback avoids synthetic IDs overlapping between the two controls.
      f.sqlite.exec('ROLLBACK TO lease_case');
      f.insertLease();
      insert(f.sqlite, otherWallet, f.owner);
    },
  );

  it('derives its complete immutable roster from the original retained review and preserves authority flags', async () => {
    const calls = f.providerCalls();
    f.insertLease();
    const held = f.sqlite
      .prepare(
        'SELECT * FROM wallet_warmup_execution_held_wallets ORDER BY wallet_address',
      )
      .all();
    const expected = f.proposed.terms.intent.wallets
      .map((w) => ({
        owner_id: f.owner,
        proposal_id: f.proposal.id,
        root_sha256: f.approval.rootSha256,
        wallet_address: w.wallet,
        wallet_revision: w.revision,
      }))
      .sort((a, b) => a.wallet_address.localeCompare(b.wallet_address));
    expect(held).toEqual(expected);
    expect(f.providerCalls()).toBe(calls);
    const saved = await readWarmupExecutionWalletLease(
      f.db,
      f.owner,
      f.proposal.id,
      new AbortController().signal,
    );
    expect(saved).toMatchObject({
      walletHoldRecorded: true,
      humanApprovalVerified: false,
      currentSourceVerified: false,
      signingAllowed: false,
      executionAllowed: false,
      automaticExecutionAllowed: false,
    });
    expect(f.providerCalls()).toBe(calls);
    const approval = await f.readApproval();
    expect(approval).toMatchObject({
      signingAllowed: false,
      executionAllowed: false,
      automaticExecutionAllowed: false,
    });
    expect(() =>
      f.sqlite
        .prepare(
          'UPDATE wallet_warmup_execution_wallet_leases SET created_at=created_at',
        )
        .run(),
    ).toThrow();
    expect(() =>
      f.sqlite
        .prepare('DELETE FROM wallet_warmup_execution_wallet_leases')
        .run(),
    ).toThrow();
    expect(() => f.insertLease()).toThrow();
  });

  it.each([
    'unknown',
    'unexpected',
    'expired',
    'finalized',
    'failed',
    'cancelled',
  ])(
    'central INSERT state %s cannot bypass the original wallet lease',
    (state) => {
      const statement = f.sqlite.prepare(
        "INSERT INTO solana_execution_reservations(owner_id,wallet_address,scope,intent_id,state) VALUES(?,?,'warmup','freeform-control',?)",
      );
      f.sqlite.exec('SAVEPOINT no_lease_control');
      statement.run(f.owner, wallet, state);
      f.sqlite.exec('ROLLBACK TO no_lease_control; RELEASE no_lease_control');
      f.insertLease();
      expect(() => statement.run(f.owner, wallet, state)).toThrow(
        'Wallet held by warmup execution',
      );
    },
  );

  it.each(['central', 'swap'])(
    '%s: same-active-state wallet mutation cannot move an unheld reservation onto the leased wallet',
    (family) => {
      direct[family]!(f.sqlite, otherWallet, f.owner);
      const table =
        family === 'central'
          ? 'solana_execution_reservations'
          : 'solana_swap_reservations';
      const mutate = f.sqlite.prepare(
        `UPDATE ${table} SET wallet_address=? WHERE owner_id=? AND wallet_address=?`,
      );
      f.sqlite.exec('SAVEPOINT identity_positive_control');
      mutate.run(wallet, f.owner, otherWallet);
      expect(
        f.sqlite
          .prepare(
            `SELECT state FROM ${table} WHERE owner_id=? AND wallet_address=?`,
          )
          .get(f.owner, wallet)!.state,
      ).toBe('awaiting_signature');
      f.sqlite.exec(
        'ROLLBACK TO identity_positive_control; RELEASE identity_positive_control',
      );
      f.insertLease();
      expect(() => mutate.run(wallet, f.owner, otherWallet)).toThrow(
        'Wallet held by warmup execution',
      );
      expect(
        f.sqlite
          .prepare(
            `SELECT state FROM ${table} WHERE owner_id=? AND wallet_address=?`,
          )
          .get(f.owner, otherWallet)!.state,
      ).toBe('awaiting_signature');
    },
  );

  it.each(
    (['finalized', 'failed', 'cancelled'] as const).flatMap((terminal) =>
      (['wallet', 'owner'] as const).map((identity) => ({
        terminal,
        identity,
      })),
    ),
  )(
    'central $identity reassignment cannot enter a leased wallet while marking $terminal',
    ({ terminal, identity }) => {
      const sourceOwner = identity === 'owner' ? otherOwner : f.owner;
      const sourceWallet = identity === 'wallet' ? otherWallet : wallet;
      direct.central!(f.sqlite, sourceWallet, sourceOwner);
      const mutate = f.sqlite.prepare(
        'UPDATE solana_execution_reservations SET owner_id=?,wallet_address=?,state=? WHERE owner_id=? AND wallet_address=?',
      );
      f.sqlite.exec('SAVEPOINT terminal_identity_positive');
      mutate.run(f.owner, wallet, terminal, sourceOwner, sourceWallet);
      expect(
        f.sqlite
          .prepare(
            'SELECT state FROM solana_execution_reservations WHERE owner_id=? AND wallet_address=?',
          )
          .get(f.owner, wallet)!.state,
      ).toBe(terminal);
      f.sqlite.exec(
        'ROLLBACK TO terminal_identity_positive; RELEASE terminal_identity_positive',
      );
      f.insertLease();
      const leaseBefore = f.sqlite
        .prepare('SELECT * FROM wallet_warmup_execution_wallet_leases')
        .all();
      expect(() =>
        mutate.run(f.owner, wallet, terminal, sourceOwner, sourceWallet),
      ).toThrow('Wallet held by warmup execution');
      expect(
        f.sqlite
          .prepare(
            'SELECT state FROM solana_execution_reservations WHERE owner_id=? AND wallet_address=?',
          )
          .get(sourceOwner, sourceWallet)!.state,
      ).toBe('awaiting_signature');
      expect(
        f.sqlite
          .prepare('SELECT * FROM wallet_warmup_execution_wallet_leases')
          .all(),
      ).toEqual(leaseBefore);
      expect(
        f.sqlite
          .prepare(
            'SELECT count(*) AS n FROM solana_execution_reservations WHERE owner_id=? AND wallet_address=?',
          )
          .get(f.owner, wallet)!.n,
      ).toBe(0);
    },
  );

  it('raw swap guards remain unconditional and its real schema restricts state to active values', () => {
    for (const kind of ['insert', 'update']) {
      const trigger = String(
        f.sqlite
          .prepare('SELECT sql FROM sqlite_master WHERE name=?')
          .get(`warmup_lease_blocks_swap_${kind}`)!.sql,
      );
      expect(trigger).not.toContain('WHEN ');
      expect(trigger).toContain(
        'h.owner_id=NEW.owner_id AND h.wallet_address=NEW.wallet_address',
      );
    }
    const ddl = String(
      f.sqlite
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='solana_swap_reservations'",
        )
        .get()!.sql,
    );
    expect(ddl).toMatch(
      /state[^]*CHECK\(state IN \('awaiting_signature','signed','submitted'\)\)/,
    );
  });

  it.each(['finalized', 'failed', 'cancelled'])(
    'unheld withdrawal %s recovery keeps the actual central update/delete chain intact',
    (terminal) => {
      f.insertLease();
      familyWithdrawal(f.sqlite, otherWallet, f.owner, 'recovery-withdrawal');
      if (terminal !== 'cancelled') {
        f.sqlite
          .prepare(
            "UPDATE native_withdrawals SET state='signing' WHERE id='recovery-withdrawal'",
          )
          .run();
        f.sqlite
          .prepare(
            "UPDATE native_withdrawals SET state='signed',signature='synthetic-withdrawal-signature' WHERE id='recovery-withdrawal'",
          )
          .run();
        f.sqlite
          .prepare(
            "UPDATE native_withdrawals SET state='submitted' WHERE id='recovery-withdrawal'",
          )
          .run();
      }
      f.sqlite
        .prepare(
          "UPDATE native_withdrawals SET state=?,receipt=? WHERE id='recovery-withdrawal'",
        )
        .run(terminal, terminal === 'finalized' ? '{}' : null);
      expect(
        f.sqlite
          .prepare(
            'SELECT count(*) AS n FROM solana_execution_reservations WHERE owner_id=? AND wallet_address=?',
          )
          .get(f.owner, otherWallet)!.n,
      ).toBe(0);
      expect(
        f.sqlite
          .prepare(
            "SELECT state FROM native_withdrawals WHERE id='recovery-withdrawal'",
          )
          .get()!.state,
      ).toBe(terminal);
    },
  );

  it.each(['signed', 'submitted'] as const)(
    'selected-wallet %s withdrawal can fail before leasing and append immutable late failure evidence afterwards',
    (beforeFailure) => {
      // All transitions use the unchanged full schema. These markers describe
      // synthetic storage history only, not a verified transaction or RPC proof.
      familyWithdrawal(f.sqlite, wallet, f.owner, 'selected-prior-withdrawal');
      f.sqlite
        .prepare(
          "UPDATE native_withdrawals SET state='signing' WHERE id='selected-prior-withdrawal'",
        )
        .run();
      f.sqlite
        .prepare(
          "UPDATE native_withdrawals SET state='signed',signature='synthetic-prior-failed-signature' WHERE id='selected-prior-withdrawal'",
        )
        .run();
      if (beforeFailure === 'submitted')
        f.sqlite
          .prepare(
            "UPDATE native_withdrawals SET state='submitted' WHERE id='selected-prior-withdrawal'",
          )
          .run();
      f.sqlite
        .prepare(
          "UPDATE native_withdrawals SET state='failed' WHERE id='selected-prior-withdrawal'",
        )
        .run();
      expect(
        f.sqlite
          .prepare(
            'SELECT count(*) AS n FROM solana_execution_reservations WHERE owner_id=? AND wallet_address=?',
          )
          .get(f.owner, wallet)!.n,
      ).toBe(0);
      const original = f.sqlite
        .prepare(
          "SELECT * FROM native_withdrawals WHERE id='selected-prior-withdrawal'",
        )
        .get()!;
      expect(original.failure_receipt).toBeNull();
      const eventsBefore = Number(
        f.sqlite
          .prepare(
            "SELECT count(*) AS n FROM native_withdrawal_events WHERE intent_id='selected-prior-withdrawal'",
          )
          .get()!.n,
      );
      f.insertLease();
      const leaseBefore = f.sqlite
        .prepare('SELECT * FROM wallet_warmup_execution_wallet_leases')
        .all();
      const heldBefore = f.sqlite
        .prepare('SELECT * FROM wallet_warmup_execution_held_wallets')
        .all();
      const failure = JSON.stringify({
        failed: true,
        detail: 'synthetic late failure storage evidence',
      });
      const enrich = f.sqlite.prepare(
        "UPDATE native_withdrawals SET failure_receipt=? WHERE id='selected-prior-withdrawal'",
      );
      enrich.run(failure);
      expect(
        f.sqlite
          .prepare(
            "SELECT * FROM native_withdrawals WHERE id='selected-prior-withdrawal'",
          )
          .get(),
      ).toEqual({ ...original, failure_receipt: failure });
      expect(
        f.sqlite
          .prepare(
            "SELECT count(*) AS n FROM native_withdrawal_events WHERE intent_id='selected-prior-withdrawal'",
          )
          .get()!.n,
      ).toBe(eventsBefore + 1);
      expect(
        f.sqlite
          .prepare(
            "SELECT state,signature,failure_receipt FROM native_withdrawal_events WHERE intent_id='selected-prior-withdrawal' ORDER BY sequence DESC LIMIT 1",
          )
          .get(),
      ).toEqual({
        state: 'failed',
        signature: 'synthetic-prior-failed-signature',
        failure_receipt: failure,
      });
      // Existing evidence stays immutable, and an idempotent same-value write
      // cannot fabricate an additional recovery event.
      enrich.run(failure);
      expect(
        f.sqlite
          .prepare(
            "SELECT count(*) AS n FROM native_withdrawal_events WHERE intent_id='selected-prior-withdrawal'",
          )
          .get()!.n,
      ).toBe(eventsBefore + 1);
      expect(() =>
        enrich.run(JSON.stringify({ failed: true, detail: 'changed' })),
      ).toThrow('Withdrawal failure evidence is immutable');
      expect(() => enrich.run(null)).toThrow(
        'Withdrawal failure evidence is immutable',
      );
      expect(
        f.sqlite
          .prepare('SELECT * FROM wallet_warmup_execution_wallet_leases')
          .all(),
      ).toEqual(leaseBefore);
      expect(
        f.sqlite
          .prepare('SELECT * FROM wallet_warmup_execution_held_wallets')
          .all(),
      ).toEqual(heldBefore);
      expect(() => direct.central!(f.sqlite, wallet, f.owner)).toThrow(
        'Wallet held by warmup execution',
      );
      expect(
        f.sqlite
          .prepare(
            'SELECT count(*) AS n FROM solana_execution_reservations WHERE owner_id=? AND wallet_address=?',
          )
          .get(f.owner, wallet)!.n,
      ).toBe(0);
    },
  );

  it('preserves the existing conservative central-reservation source rule even for a terminal marker', () => {
    f.sqlite
      .prepare(
        "INSERT INTO solana_execution_reservations(owner_id,wallet_address,scope,intent_id,state) VALUES(?,?,'warmup','terminal-control','finalized')",
      )
      .run(f.owner, wallet);
    // The original root-current busy predicate considers any central row busy.
    // Do not manufacture coexisting active rows to exercise UPDATE guards.
    expect(() => f.insertLease()).toThrow(
      'Warmup proposal source is no longer current',
    );
  });

  it('installs all 36 exact reverse guards on the full migrated schema', () => {
    for (const [family] of families)
      for (const kind of ['insert', 'update']) {
        const name = `warmup_lease_blocks_${family}_${kind}`;
        const installed = String(
          f.sqlite
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
            )
            .get(name)!.sql,
        ).replace(/\r\n/g, '\n');
        const source = migration
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .find((s) => s.startsWith(`CREATE TRIGGER ${name} `))!;
        expect(installed).toBe(source.replace(/;$/, ''));
      }
  });

  it.each([
    [
      'central',
      [
        'awaiting_signature',
        'signing',
        'signed',
        'submitting',
        'submitted',
        'reserved',
      ],
    ],
    ['imported', ['awaiting_signature', 'signed', 'submitted']],
    ['warmup', ['awaiting_signature', 'signed', 'submitted']],
    ['withdrawal', ['awaiting_signature', 'signing', 'signed', 'submitted']],
    ['pair', ['reserved', 'signed', 'submitting', 'submitted']],
    ['nuke', ['review', 'signed', 'submitting', 'submitted']],
    ['volume_bundle', ['held', 'attempted']],
    ['cleanup', ['awaiting_signature', 'signing', 'signed', 'submitted']],
    ['supply', ['awaiting_signature', 'signing', 'signed', 'submitted']],
    ['volume_parent', ['active']],
    ['organic_parent', ['active']],
    ['volume_batch', ['review', 'signed']],
    ['organic_batch', ['review', 'signed']],
    ['volume_child', ['signed', 'submitting', 'submitted']],
    ['organic_child', ['signed', 'submitting', 'submitted']],
  ] as const)(
    '%s: the installed whole-NEW predicate covers every active state and excludes terminal writes',
    (family, active) => {
      const installed = String(
        f.sqlite
          .prepare('SELECT sql FROM sqlite_master WHERE name=?')
          .get(`warmup_lease_blocks_${family}_update`)!.sql,
      );
      const predicate = installed.slice(
        installed.indexOf('WHEN ') + 5,
        installed.indexOf(' BEGIN'),
      );
      // Evaluate the ACTUAL installed WHEN expression, without inventing rows that
      // production admission correctly prevents from coexisting with a lease.
      const evaluate = f.sqlite.prepare(
        `WITH NEW AS (SELECT ? AS state,'owner' AS owner_id,'wallet' AS wallet_address,'warmup' AS scope,'intent' AS intent_id), OLD AS (SELECT 'owner' AS owner_id,'wallet' AS wallet_address,'warmup' AS scope,'intent' AS intent_id) SELECT CASE WHEN ${predicate} THEN 1 ELSE 0 END AS guarded FROM NEW,OLD`,
      );
      for (const state of active) expect(evaluate.get(state)!.guarded).toBe(1);
      for (const state of ['finalized', 'failed', 'cancelled'])
        expect(evaluate.get(state)!.guarded).toBe(0);
    },
  );

  it('Counter guard retains approved-expired holds and the exact unsigned expiry boundary', () => {
    const trigger = String(
      f.sqlite
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='warmup_lease_blocks_counter_update'",
        )
        .get()!.sql,
    );
    const predicate = trigger.slice(
      trigger.indexOf('WHEN ') + 5,
      trigger.indexOf(' BEGIN'),
    );
    const evaluate = f.sqlite.prepare(
      `WITH NEW AS (SELECT ? AS approval_id,? AS expires_at) SELECT CASE WHEN ${predicate} THEN 1 ELSE 0 END AS guarded FROM NEW`,
    );
    expect(
      evaluate.get(null, new Date(Date.parse(f.sqlClock()) + 1).toISOString())!
        .guarded,
    ).toBe(1);
    expect(evaluate.get(null, f.sqlClock())!.guarded).toBe(0);
    expect(evaluate.get(null, old)!.guarded).toBe(0);
    expect(evaluate.get('retained-approval', old)!.guarded).toBe(1);
  });

  it('actual launch guard predicate matches payer or participating holder, but not none/other-owner/unselected wallets', () => {
    f.insertLease();
    const trigger = String(
      f.sqlite
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='warmup_lease_blocks_launch_update'",
        )
        .get()!.sql,
    );
    const expression = trigger.slice(
      trigger.indexOf(' WHERE EXISTS(') + 7,
      trigger.lastIndexOf(';'),
    );
    const evaluate = f.sqlite.prepare(
      `WITH NEW AS (SELECT ? AS owner_id,? AS payer,? AS review) SELECT ${expression} AS guarded FROM NEW`,
    );
    const review = (
      address: string,
      kind: string,
      format = 'pump-launch-group-review-v1',
    ) => JSON.stringify({ format, input: { holders: [{ address, kind }] } });
    expect(
      evaluate.get(f.owner, wallet, review(otherWallet, 'none'))!.guarded,
    ).toBe(1);
    expect(
      evaluate.get(f.owner, otherWallet, review(wallet, 'buy'))!.guarded,
    ).toBe(1);
    expect(
      evaluate.get(
        f.owner,
        otherWallet,
        review(wallet, 'buy', 'pump-create-holders-review-v1'),
      )!.guarded,
    ).toBe(1);
    expect(
      evaluate.get(f.owner, otherWallet, review(wallet, 'none'))!.guarded,
    ).toBe(0);
    expect(
      evaluate.get(otherOwner, wallet, review(wallet, 'buy'))!.guarded,
    ).toBe(0);
    expect(
      evaluate.get(f.owner, otherWallet, review(otherWallet, 'buy'))!.guarded,
    ).toBe(0);
    expect(
      evaluate.get(
        f.owner,
        otherWallet,
        review(wallet, 'buy', 'unknown-format'),
      )!.guarded,
    ).toBe(0);
    const predicate = trigger.slice(
      trigger.indexOf('WHEN ') + 5,
      trigger.indexOf(' BEGIN'),
    );
    const active = f.sqlite.prepare(
      `WITH NEW AS (SELECT ? AS state,'owner' AS owner_id,'wallet' AS wallet_address,'warmup' AS scope,'intent' AS intent_id), OLD AS (SELECT 'owner' AS owner_id,'wallet' AS wallet_address,'warmup' AS scope,'intent' AS intent_id) SELECT CASE WHEN ${predicate} THEN 1 ELSE 0 END AS guarded FROM NEW,OLD`,
    );
    for (const state of ['review', 'signed', 'submitted'])
      expect(active.get(state)!.guarded).toBe(1);
    for (const state of ['cancelled', 'failed', 'finalized'])
      expect(active.get(state)!.guarded).toBe(0);
  });

  it('does not replace either 0137 family hold view', () => {
    for (const name of [
      'solana_wallet_family_holds',
      'solana_scheduled_family_holds',
    ]) {
      const original = previous
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .find((s) => s.startsWith(`CREATE VIEW ${name} AS`));
      expect(original).toBeDefined();
      expect(
        f.sqlite
          .prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name=?")
          .get(name)!.sql,
      ).toBe(original!.replace(/;$/, ''));
    }
    expect(migration).not.toMatch(
      /DROP\s+(VIEW|TRIGGER)|CREATE VIEW solana_(wallet|scheduled)_family_holds/i,
    );
  });

  it.each(['cleanup', 'supply'] as const)(
    '%s: terminal proof persistence on an unheld wallet remains reachable',
    (family) => {
      f.insertLease();
      const id = reserveFamily(f.sqlite, family, otherWallet, f.owner);
      const table =
        family === 'cleanup' ? 'wallet_cleanups' : 'token_supply_actions';
      f.sqlite
        .prepare(`UPDATE ${table} SET state='signing' WHERE id=?`)
        .run(id);
      f.sqlite
        .prepare(
          `UPDATE ${table} SET state='signed',signature='synthetic-storage-signature' WHERE id=?`,
        )
        .run(id);
      f.sqlite
        .prepare(`UPDATE ${table} SET state='submitted' WHERE id=?`)
        .run(id);
      // Real storage transition only: this fixture does not assert chain proof.
      f.sqlite
        .prepare(
          `UPDATE ${table} SET state='finalized',receipt='{}' WHERE id=?`,
        )
        .run(id);
      expect(
        f.sqlite
          .prepare(`SELECT state,receipt FROM ${table} WHERE id=?`)
          .get(id),
      ).toEqual({ state: 'finalized', receipt: '{}' });
    },
  );

  it('a later external manual receipt preserves historical lease metadata and invalidates current source', () => {
    f.insertLease();
    const before = f.sqlite
      .prepare('SELECT * FROM wallet_warmup_execution_wallet_leases')
      .all();
    // Actual receipt table allows independent manual receipt history; no v2
    // execution/preparation ID and no caller-supplied signatureVerified claim.
    f.sqlite
      .prepare(`INSERT INTO warmup_buy_receipts(id,owner_id,preparation_id,plan_id,plan_revision,cycle,wallet_address,wallet_revision,signature,document,created_at)
      VALUES('later-manual-receipt',?,'external-manual-preparation',?,1,99,?,1,'synthetic-manual-signature','{}',?)`)
      .run(f.owner, f.source.retainedReview.planId, wallet, f.sqlClock());
    expect(
      f.sqlite
        .prepare('SELECT * FROM wallet_warmup_execution_wallet_leases')
        .all(),
    ).toEqual(before);
    const counts = f.sqlite
      .prepare(
        "SELECT json_array_length(r.source,'$.buys') AS expected,(SELECT count(*) FROM warmup_buy_receipts b WHERE b.owner_id=r.owner_id AND b.plan_id=r.plan_id) AS actual FROM wallet_warmup_session_reviews r WHERE r.owner_id=? AND r.id=?",
      )
      .get(f.owner, f.approval.reviewId)!;
    expect(Number(counts.actual)).toBe(Number(counts.expected) + 1);
    expect(
      f.sqlite
        .prepare(
          'SELECT wallet_address FROM wallet_warmup_execution_held_wallets',
        )
        .all(),
    ).toContainEqual({ wallet_address: wallet });
    expect(() => direct.central!(f.sqlite, wallet, f.owner)).toThrow(
      'Wallet held by warmup execution',
    );
  });

  it('does not add an HTTP activation or signer call site', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const callers = walk('app/api')
      .filter((p) => /\.(ts|tsx)$/.test(p))
      .filter((p) =>
        /wallet-warmup-execution-lease|retainWarmupExecutionWalletLease|wallet_warmup_execution_wallet_leases/.test(
          readFileSync(p, 'utf8'),
        ),
      );
    expect(callers).toEqual([]);
  });
});

const families = [
  ['central', 'solana_execution_reservations'],
  ['swap', 'solana_swap_reservations'],
  ['imported', 'imported_swap_signing_intents'],
  ['warmup', 'warmup_signing_intents'],
  ['withdrawal', 'native_withdrawals'],
  ['launch', 'pump_launch_reviews'],
  ['pair', 'pair_order_executions'],
  ['counter', 'counter_proposal_reservations'],
  ['nuke', 'sniper_nuke_sells'],
  ['volume_bundle', 'volume_bundle_reservations'],
  ['cleanup', 'wallet_cleanups'],
  ['supply', 'token_supply_actions'],
  ['volume_parent', 'volume_bot_sessions'],
  ['organic_parent', 'pump_organic_sequences'],
  ['volume_batch', 'volume_bot_batches'],
  ['organic_batch', 'pump_organic_batches'],
  ['volume_child', 'volume_bot_trades'],
  ['organic_child', 'pump_organic_buys'],
] as const;

// Admission prevents an active financial row and its conflicting lease from
// coexisting. These assertions cover ALL paired real INSERT/whole-UPDATE guards
// without dropping production guards or manufacturing an impossible overlap.
// They do not claim full lifecycle admission for complex launch/Counter parents.
describe('all reverse guard definitions', () => {
  it.each(families)(
    '%s guards INSERT and every active UPDATE, not just a state transition',
    (family, table) => {
      const sql = (kind: string) => {
        const found = migration
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .find((s) =>
            s.startsWith(
              `CREATE TRIGGER warmup_lease_blocks_${family}_${kind} `,
            ),
          );
        expect(found).toBeDefined();
        return found!;
      };
      const insert = sql('insert'),
        update = sql('update');
      expect(insert).toContain(`BEFORE INSERT ON ${table}`);
      expect(update).toContain(`BEFORE UPDATE ON ${table}`);
      expect(update).not.toContain('UPDATE OF');
      if (family === 'central') {
        for (const field of [
          'owner_id',
          'wallet_address',
          'scope',
          'intent_id',
        ])
          expect(update).toContain(`NEW.${field} IS NOT OLD.${field}`);
        expect(update).toContain('NEW.state IS NULL');
        expect(update).toContain(
          "NEW.state NOT IN ('finalized','failed','cancelled')",
        );
      } else expect(update).not.toMatch(/OLD\./);
      expect(update.slice(update.indexOf(' BEGIN'))).toBe(
        insert.slice(insert.indexOf(' BEGIN')),
      );
      expect(update).toContain('wallet_warmup_execution_held_wallets');
      expect(update).toContain(
        "RAISE(ABORT,'Wallet held by warmup execution')",
      );
      expect(update).not.toMatch(
        /signingAllowed|verified\s*=\s*1|DELETE FROM|UPDATE .* SET/,
      );
    },
  );
  it('keeps launch payer and non-none holders, batch parent rosters, and actual unresolved child addresses', () => {
    expect(migration).toContain('h.wallet_address=NEW.payer OR EXISTS');
    expect(migration).toContain("json_extract(w.value,'$.kind')!='none'");
    expect(migration).toContain(
      'h.wallet_address=NEW.wallet AND (h.owner_id=NEW.owner_id OR h.owner_id=b.owner_id OR h.owner_id=s.owner_id)',
    );
    expect(migration).toContain(
      'h.wallet_address=NEW.holder AND (h.owner_id=NEW.owner_id OR h.owner_id=b.owner_id OR h.owner_id=s.owner_id)',
    );
    expect(migration).toContain("json_each(s.plan,'$.wallets')");
    expect(migration).toContain("json_each(s.plan,'$.rows')");
  });
});
