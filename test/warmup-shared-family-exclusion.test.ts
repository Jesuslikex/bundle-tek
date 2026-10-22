import { afterEach, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  solanaFamilyExclusionFixture,
  exclusionWallet,
  exclusionOwner,
  exclusionFamilies,
  familyTables,
  reserveFamily,
  familyWithdrawal,
  signFamily,
  stopFamily,
  unresolvedScheduledTrade,
} from './solana-family-exclusion-fixture';

const databases: DatabaseSync[] = [];
const fixture = () => {
  const db = solanaFamilyExclusionFixture();
  databases.push(db);
  return db;
};
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

for (const family of ['organic', 'volume'] as const) {
  it(`${family}: stopped unresolved work conservatively retains every selected wallet`, () => {
    const db = fixture();
    reserveFamily(
      db,
      family,
      exclusionWallet,
      exclusionOwner,
      '',
      'other-selected-wallet',
    );
    unresolvedScheduledTrade(db, family, 'submitted');
    stopFamily(db, family);
    expect(() => reserveFamily(db, 'cleanup', 'other-selected-wallet')).toThrow(
      /reserved/i,
    );
    expect(() => familyWithdrawal(db, 'other-selected-wallet')).toThrow(
      /reserved/i,
    );
  });
  it(`${family}: legacy conflicts refuse a new unsigned batch before signing`, () => {
    const db = solanaFamilyExclusionFixture(136);
    databases.push(db);
    reserveFamily(db, family);
    reserveFamily(db, 'cleanup');
    db.exec(
      readFileSync('drizzle/0137_solana_wallet_family_exclusion.sql', 'utf8'),
    );
    expect(() => unresolvedScheduledTrade(db, family, 'signed', false)).toThrow(
      /reserved/i,
    );
    expect(
      count(
        db,
        family === 'organic' ? 'pump_organic_batches' : 'volume_bot_batches',
      ),
    ).toBe(0);
    expect(
      count(
        db,
        family === 'organic' ? 'pump_organic_buys' : 'volume_bot_trades',
      ),
    ).toBe(0);
  });
  it(`${family}: signed rows must belong to the exact owned batch and selected wallet set`, () => {
    const db = fixture();
    reserveFamily(db, family);
    unresolvedScheduledTrade(db, family, 'signed', false);
    const sql =
      family === 'organic'
        ? "INSERT INTO pump_organic_buys(owner_id,batch_id,buy_index,holder,signed,signature,state) VALUES(?,?,1,?,'synthetic-packet','outside-synthetic-signature','signed')"
        : "INSERT INTO volume_bot_trades(owner_id,batch_id,trade_index,round,side,wallet,signed,signature,state) VALUES(?,?,1,0,'Buy',?,'synthetic-packet','outside-synthetic-signature','signed')";
    expect(() =>
      db.prepare(sql).run(exclusionOwner, `${family}-batch`, 'outside-wallet'),
    ).toThrow(/differs/i);
    expect(() =>
      db.prepare(sql).run('other-owner', `${family}-batch`, exclusionWallet),
    ).toThrow(/differs/i);
    expect(
      count(
        db,
        family === 'organic' ? 'pump_organic_buys' : 'volume_bot_trades',
      ),
    ).toBe(1);
  });
}

it('same-batch cleanup close and sell can claim signing and sending together without self-conflict', () => {
  const db = fixture();
  reserveFamily(db, 'cleanup');
  db.prepare(`INSERT INTO wallet_cleanups
 (id,owner_id,batch_id,wallet_address,wallet_revision,destination,document,state,created_at,updated_at)
 VALUES('cleanup-sell',?,'cleanup-batch',?,1,'synthetic-destination','{"format":"wallet-cleanup-sell-v1"}','awaiting_signature','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z')`).run(
    exclusionOwner,
    exclusionWallet,
  );
  expect(
    db.prepare("UPDATE wallet_cleanups SET state='signing'").run().changes,
  ).toBe(2);
  db.prepare(
    "UPDATE wallet_cleanups SET state='signed',signature=id||'-synthetic'",
  ).run();
  expect(
    db.prepare("UPDATE wallet_cleanups SET state='submitted'").run().changes,
  ).toBe(2);
});

it('one volume batch may have its own unresolved Buy and Sell without blocking itself', () => {
  const db = fixture();
  reserveFamily(db, 'volume');
  unresolvedScheduledTrade(db, 'volume', 'submitting', false);
  db.prepare(
    "INSERT INTO volume_bot_trades(owner_id,batch_id,trade_index,round,side,wallet,signed,signature,state) VALUES(?,'volume-batch',1,0,'Sell',?,'synthetic-packet','second-synthetic-signature','signed')",
  ).run(exclusionOwner, exclusionWallet);
  db.prepare(
    "UPDATE volume_bot_trades SET state='submitting' WHERE trade_index=1",
  ).run();
  expect(count(db, 'volume_bot_trades')).toBe(2);
});

it('one organic sequence may prepare its next reviewed batch while its previous batch is submitted', () => {
  const db = fixture();
  reserveFamily(db, 'organic');
  unresolvedScheduledTrade(db, 'organic', 'submitted', false);
  db.prepare(`INSERT INTO pump_organic_batches(id,owner_id,sequence_id,batch,review,review_sha256,state,expires_at)
 VALUES('organic-next',?,'organic-storage-owner',1,'{}',?,'review',?)`).run(
    exclusionOwner,
    'c'.repeat(64),
    new Date(Date.now() + 3600000).toISOString(),
  );
  expect(count(db, 'pump_organic_batches')).toBe(2);
  expect(db.prepare('SELECT state FROM pump_organic_buys').get()).toEqual({
    state: 'submitted',
  });
});

it('keeps two legacy signed conflicts reserved and permits verified-outcome storage transitions without a new send', () => {
  const db = solanaFamilyExclusionFixture(136);
  databases.push(db);
  reserveFamily(db, 'cleanup');
  reserveFamily(db, 'supply');
  signFamily(db, 'cleanup');
  signFamily(db, 'supply');
  db.exec(
    readFileSync('drizzle/0137_solana_wallet_family_exclusion.sql', 'utf8'),
  );
  for (const table of ['wallet_cleanups', 'token_supply_actions'])
    expect(() =>
      db.prepare(`UPDATE ${table} SET state='submitted'`).run(),
    ).toThrow(/reserved/i);
  // Storage transition only; real receipt decoding is proved separately by HTTP fixture.
  db.prepare(
    "UPDATE token_supply_actions SET state='failed',receipt='{\"failed\":true}'",
  ).run();
  expect(
    db.prepare("UPDATE wallet_cleanups SET state='submitted'").run().changes,
  ).toBe(1);
});
const count = (db: DatabaseSync, table: string) =>
  (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;

for (const holding of exclusionFamilies) {
  for (const entering of exclusionFamilies.filter((f) => f !== holding)) {
    it(`${holding} and ${entering} remain independent across owners`, () => {
      const db = fixture();
      reserveFamily(db, holding);
      reserveFamily(db, entering, exclusionWallet, 'other-owner');
      expect(count(db, familyTables[holding])).toBe(1);
      expect(count(db, familyTables[entering])).toBe(1);
    });
    it(`${holding} blocks concurrent ${entering} admission on the same owned wallet`, () => {
      const db = fixture();
      reserveFamily(db, holding);
      expect(() => reserveFamily(db, entering)).toThrow(/reserved/i);
      expect(count(db, familyTables[holding])).toBe(1);
      expect(count(db, familyTables[entering])).toBe(0);
    });
  }
}

it.each(['cleanup', 'supply'] as const)(
  '%s rechecks a legacy-repointed central hold before permitting a signing claim',
  (family) => {
    const db = solanaFamilyExclusionFixture(136);
    databases.push(db);
    reserveFamily(db, family);
    familyWithdrawal(db, 'other-wallet');
    db.prepare('UPDATE solana_execution_reservations SET wallet_address=?').run(
      exclusionWallet,
    );
    db.exec(
      readFileSync('drizzle/0137_solana_wallet_family_exclusion.sql', 'utf8'),
    );
    expect(() =>
      db.prepare(`UPDATE ${familyTables[family]} SET state='signing'`).run(),
    ).toThrow(/reserved/i);
    expect(
      db.prepare(`SELECT state FROM ${familyTables[family]}`).get(),
    ).toEqual({ state: 'awaiting_signature' });
  },
);

for (const family of ['organic', 'volume'] as const) {
  it(`${family} cannot reactivate even when its old wallets are otherwise idle`, () => {
    const db = fixture();
    reserveFamily(db, family);
    stopFamily(db, family);
    expect(() =>
      db.prepare(`UPDATE ${familyTables[family]} SET state='active'`).run(),
    ).toThrow(/reactivated/i);
  });
  it(`${family} stops unsigned work and releases only explicitly cancelled signed rows`, () => {
    const db = fixture();
    reserveFamily(db, family);
    unresolvedScheduledTrade(db, family, 'signed', false);
    stopFamily(db, family);
    expect(() => reserveFamily(db, 'cleanup')).toThrow(/reserved/i);
    db.prepare(
      `UPDATE ${family === 'organic' ? 'pump_organic_buys' : 'volume_bot_trades'} SET state='cancelled'`,
    ).run();
    reserveFamily(db, 'cleanup');
    expect(count(db, 'wallet_cleanups')).toBe(1);
  });
  it(`${family} rechecks a legacy-repointed central hold before dispatch`, () => {
    const db = solanaFamilyExclusionFixture(136);
    databases.push(db);
    reserveFamily(db, family);
    unresolvedScheduledTrade(db, family, 'signed', false);
    familyWithdrawal(db, 'other-wallet');
    db.prepare('UPDATE solana_execution_reservations SET wallet_address=?').run(
      exclusionWallet,
    );
    db.exec(
      readFileSync('drizzle/0137_solana_wallet_family_exclusion.sql', 'utf8'),
    );
    expect(() =>
      db
        .prepare(
          `UPDATE ${family === 'organic' ? 'pump_organic_buys' : 'volume_bot_trades'} SET state='submitting'`,
        )
        .run(),
    ).toThrow(/reserved/i);
  });
}

it('refuses a second independent supply review in the database, not only in a route preflight', () => {
  const db = fixture();
  reserveFamily(db, 'supply');
  expect(() =>
    reserveFamily(db, 'supply', exclusionWallet, exclusionOwner, '-second'),
  ).toThrow(/reserved/i);
  expect(count(db, 'token_supply_actions')).toBe(1);
  expect(count(db, 'token_supply_action_events')).toBe(1);
});

for (const holding of ['organic', 'volume'] as const) {
  for (const entering of ['cleanup', 'supply'] as const) {
    it.each(['signed', 'submitting', 'submitted'] as const)(
      `${holding}: stopped/expired but unresolved %s work blocks new ${entering}`,
      (state) => {
        const db = fixture();
        reserveFamily(db, holding);
        unresolvedScheduledTrade(db, holding, state);
        stopFamily(db, holding);
        expect(() => reserveFamily(db, entering)).toThrow(/reserved/i);
        expect(count(db, familyTables[entering])).toBe(0);
      },
    );
  }
}

it.each(['organic', 'volume'] as const)(
  '%s cannot reactivate an unsigned stopped session after another family takes its wallet',
  (family) => {
    const db = fixture();
    reserveFamily(db, family);
    stopFamily(db, family);
    reserveFamily(db, 'cleanup');
    expect(() =>
      db.prepare(`UPDATE ${familyTables[family]} SET state='active'`).run(),
    ).toThrow(/reactivated/i);
    expect(
      db.prepare(`SELECT state FROM ${familyTables[family]}`).get(),
    ).toEqual({ state: family === 'organic' ? 'stopped' : 'cancelled' });
  },
);

it.each(['organic', 'volume'] as const)(
  '%s cannot rewrite its identity or plan to move a hold',
  (family) => {
    const db = fixture();
    reserveFamily(db, family);
    for (const [key, value] of [
      ['id', 'replacement'],
      ['owner_id', 'other-owner'],
      ['plan', '{}'],
      ['created_at', '2001-01-01T00:00:00.000Z'],
    ])
      expect(() =>
        db.prepare(`UPDATE ${familyTables[family]} SET ${key}=?`).run(value),
      ).toThrow(/immutable/i);
    expect(() => familyWithdrawal(db)).toThrow(/reserved/i);
  },
);

it('upgrades existing conflicting unsigned rows without deleting them; refuses signing until explicit cancellation removes the conflict', () => {
  const db = solanaFamilyExclusionFixture(136);
  databases.push(db);
  reserveFamily(db, 'cleanup');
  reserveFamily(db, 'supply');
  db.exec(
    readFileSync('drizzle/0137_solana_wallet_family_exclusion.sql', 'utf8'),
  );
  expect(count(db, 'wallet_cleanups')).toBe(1);
  expect(count(db, 'token_supply_actions')).toBe(1);
  expect(() =>
    db.prepare("UPDATE wallet_cleanups SET state='signing'").run(),
  ).toThrow(/reserved/i);
  expect(() =>
    db.prepare("UPDATE token_supply_actions SET state='signing'").run(),
  ).toThrow(/reserved/i);
  stopFamily(db, 'cleanup');
  signFamily(db, 'supply', true);
  expect(db.prepare('SELECT state FROM token_supply_actions').get()).toEqual({
    state: 'submitted',
  });
  expect(count(db, 'wallet_cleanups')).toBe(1);
});

it.each(['organic', 'volume'] as const)(
  '%s cannot dispatch pre-existing signed work alongside another retained family after upgrade',
  (family) => {
    const db = solanaFamilyExclusionFixture(136);
    databases.push(db);
    reserveFamily(db, family);
    unresolvedScheduledTrade(db, family, 'signed', false);
    reserveFamily(db, 'cleanup');
    db.exec(
      readFileSync('drizzle/0137_solana_wallet_family_exclusion.sql', 'utf8'),
    );
    const table =
      family === 'organic' ? 'pump_organic_buys' : 'volume_bot_trades';
    expect(() =>
      db.prepare(`UPDATE ${table} SET state='submitting'`).run(),
    ).toThrow(/reserved/i);
    expect(db.prepare(`SELECT state FROM ${table}`).get()).toEqual({
      state: 'signed',
    });
  },
);

for (const family of exclusionFamilies) {
  it(`${family}: a shared hold cannot be repointed onto this wallet through identity UPDATE`, () => {
    const db = fixture();
    reserveFamily(db, family);
    familyWithdrawal(db, 'other-wallet');
    expect(() =>
      db
        .prepare('UPDATE solana_execution_reservations SET wallet_address=?')
        .run(exclusionWallet),
    ).toThrow(/reserved/i);
    expect(
      db
        .prepare('SELECT wallet_address FROM solana_execution_reservations')
        .get(),
    ).toEqual({ wallet_address: 'other-wallet' });
  });
  it(`${family}: positive admission on the complete schema blocks a competing real withdrawal parent and bridge atomically`, () => {
    const db = fixture();
    reserveFamily(db, family);
    expect(count(db, familyTables[family])).toBe(1);
    expect(() => familyWithdrawal(db)).toThrow(/reserved/i);
    expect(count(db, 'native_withdrawals')).toBe(0);
    expect(count(db, 'native_withdrawal_events')).toBe(0);
    expect(count(db, 'solana_execution_reservations')).toBe(0);
    expect(count(db, familyTables[family])).toBe(1);
  });
  it(`${family}: an existing real withdrawal parent refuses new admission without partial family state`, () => {
    const db = fixture();
    familyWithdrawal(db);
    expect(() => reserveFamily(db, family)).toThrow(/reserved/i);
    expect(count(db, familyTables[family])).toBe(0);
    expect(count(db, 'native_withdrawals')).toBe(1);
    expect(count(db, 'solana_execution_reservations')).toBe(1);
  });
  it(`${family}: unsigned stop/cancellation permits a new withdrawal but does not delete source history`, () => {
    const db = fixture();
    reserveFamily(db, family);
    stopFamily(db, family);
    familyWithdrawal(db);
    expect(count(db, familyTables[family])).toBe(1);
    expect(count(db, 'solana_execution_reservations')).toBe(1);
  });
  it(`${family}: the same address under another owner and another address under this owner remain independent`, () => {
    const db = fixture();
    reserveFamily(db, family);
    familyWithdrawal(
      db,
      exclusionWallet,
      'other-owner',
      'other-owner-withdrawal',
    );
    familyWithdrawal(
      db,
      'other-wallet',
      exclusionOwner,
      'other-wallet-withdrawal',
    );
    expect(count(db, 'native_withdrawals')).toBe(2);
  });
}

it('preserves the existing same-batch cleanup sell/close composition', () => {
  const db = fixture();
  reserveFamily(db, 'cleanup');
  db.prepare(`INSERT INTO wallet_cleanups
    (id,owner_id,batch_id,wallet_address,wallet_revision,destination,document,state,created_at,updated_at)
    VALUES('cleanup-sell',?,'cleanup-batch',?,1,'synthetic-destination','{"format":"wallet-cleanup-sell-v1"}','awaiting_signature','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z')`).run(
    exclusionOwner,
    exclusionWallet,
  );
  expect(count(db, 'wallet_cleanups')).toBe(2);
  expect(() => familyWithdrawal(db)).toThrow(/reserved/i);
});

for (const family of ['cleanup', 'supply'] as const) {
  it.each([false, true])(
    `${family}: signed/submitted source remains exclusive even with a year-2000 creation time (%s)`,
    (submitted) => {
      const db = fixture();
      reserveFamily(db, family);
      signFamily(db, family, submitted);
      expect(() => familyWithdrawal(db)).toThrow(/reserved/i);
      expect(count(db, 'native_withdrawals')).toBe(0);
      expect(() => stopFamily(db, family)).toThrow();
      expect(count(db, familyTables[family])).toBe(1);
    },
  );
}

for (const family of ['organic', 'volume'] as const) {
  it.each(['signed', 'submitting', 'submitted'] as const)(
    `${family}: stopping the session and expiring its batch does not free an unresolved %s trade`,
    (state) => {
      const db = fixture();
      reserveFamily(db, family);
      unresolvedScheduledTrade(db, family, state);
      stopFamily(db, family);
      expect(() => familyWithdrawal(db)).toThrow(/reserved/i);
      expect(count(db, 'native_withdrawals')).toBe(0);
      const table =
        family === 'organic' ? 'pump_organic_buys' : 'volume_bot_trades';
      expect(db.prepare(`SELECT state FROM ${table}`).get()).toEqual({ state });
    },
  );
}

it.each(['organic', 'volume'] as const)(
  '%s: unsigned stopped sessions remain retained and cannot send an old signed batch through the real send guard',
  (family) => {
    const db = fixture();
    reserveFamily(db, family);
    unresolvedScheduledTrade(db, family, 'signed');
    stopFamily(db, family);
    const table =
      family === 'organic' ? 'pump_organic_buys' : 'volume_bot_trades';
    expect(() =>
      db.prepare(`UPDATE ${table} SET state='submitting'`).run(),
    ).toThrow(/stopped|cancelled|expired/i);
    expect(db.prepare(`SELECT state FROM ${table}`).get()).toEqual({
      state: 'signed',
    });
  },
);
