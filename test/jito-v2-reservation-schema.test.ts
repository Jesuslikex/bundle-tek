import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { jitoBundleFixture } from './jito-bundle-fixture';
import { jitoDatabase } from './jito-sqlite';
import { solanaFamilyExclusionFixture } from './solana-family-exclusion-fixture';

const databases: ReturnType<typeof jitoDatabase>[] = [];
afterEach(() => {
  for (const d of databases.splice(0)) d.sqlite.close();
});
const migration = readFileSync(
  'drizzle/0163_jito_signing_reservations.sql',
  'utf8',
);

it('applies the complete migration chain in a disposable SQLite database', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const journal = JSON.parse(
      readFileSync('drizzle/meta/_journal.json', 'utf8'),
    ) as { entries: { tag: string }[] };
    for (const { tag } of journal.entries)
      db.exec(readFileSync(`drizzle/${tag}.sql`, 'utf8'));
    expect(db.prepare('PRAGMA integrity_check').get()).toMatchObject({
      integrity_check: 'ok',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('jito_sign_attempts','jito_sign_receipts','jito_bundle_protocol')",
        )
        .get()?.n,
    ).toBe(3);
  } finally {
    db.close();
  }
});

it('applies and rolls back exact receipt writes under the complete production trigger chain', async () => {
  const f = await jitoBundleFixture();
  const db = solanaFamilyExclusionFixture();
  try {
    const now = f.manifest.createdAt,
      r = f.review;
    db.prepare(
      'INSERT INTO imported_token_projects(owner_id,id,chain,address,document,revision,archived,mutation_id,updated_at) VALUES(?,?,?,?,?,1,0,?,?)',
    ).run(
      'owner',
      f.manifest.projectId,
      'Solana',
      r.outputMint,
      JSON.stringify({ token: { decimals: 6 } }),
      crypto.randomUUID(),
      now,
    );
    db.prepare(
      'INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,archived,revision,updated_at) VALUES(?,?,?,?,?,?,0,1,?)',
    ).run('owner', 'Solana', r.wallet, 'folder', 'wallet', 'trading', now);
    const session = {
      projectRevision: 1,
      mint: r.outputMint,
      decimals: 6,
      side: 'Buy',
      entries: [
        { entry: 1, wallet: r.wallet, walletRevision: 1, unitsRaw: r.inputRaw },
      ],
    };
    db.prepare(
      "INSERT INTO imported_trade_sessions VALUES(?,?,?,?,'active',1,?,?)",
    ).run(
      'owner',
      f.manifest.sessionId,
      f.manifest.projectId,
      JSON.stringify(session),
      now,
      now,
    );
    const preparation = {
      session: r.session,
      side: 'Buy',
      inAmountRaw: r.inputRaw,
      transaction: { sha256: r.sha256 },
      minimumOutRaw: r.minimumOutputRaw,
      inputMint: r.inputMint,
      outputMint: r.outputMint,
    };
    db.prepare(
      'INSERT INTO imported_swap_preparations VALUES(?,?,?,1,?,1,?,?)',
    ).run(
      r.preparationId,
      'owner',
      f.manifest.projectId,
      r.wallet,
      JSON.stringify(preparation),
      now,
    );
    db.prepare(
      "INSERT INTO imported_swap_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,signature,created_at,updated_at) VALUES(?,?,?,?,?,'awaiting_signature',NULL,?,?)",
    ).run(
      r.id,
      'owner',
      r.preparationId,
      r.wallet,
      JSON.stringify(r),
      now,
      now,
    );
    db.prepare(
      "INSERT INTO jito_bundles VALUES(?,?,?,?,?,'reviewed',NULL,?,?)",
    ).run(
      'owner',
      f.manifest.id,
      f.manifest.projectId,
      f.manifest.sessionId,
      JSON.stringify(f.manifest),
      now,
      now,
    );
    db.prepare('INSERT INTO jito_bundle_protocol VALUES(?,?,?,?,?)').run(
      'owner',
      f.manifest.id,
      2,
      f.manifest.sha256,
      now,
    );
    db.prepare('INSERT INTO jito_bundle_packets VALUES(?,?,?,?,NULL,NULL)').run(
      'owner',
      f.manifest.id,
      0,
      r.id,
    );
    db.prepare('INSERT INTO jito_bundle_packets VALUES(?,?,?,?,NULL,NULL)').run(
      'owner',
      f.manifest.id,
      1,
      null,
    );
    const attempt = crypto.randomUUID();
    db.prepare('INSERT INTO jito_sign_attempts VALUES(?,?,?,?,?,?,?,?)').run(
      'owner',
      f.manifest.id,
      0,
      attempt,
      f.manifest.sha256,
      r.wallet,
      r.id,
      now,
    );
    db.exec(
      "CREATE TRIGGER fixture_full_fail_packet BEFORE UPDATE OF signature ON jito_bundle_packets BEGIN SELECT RAISE(ABORT,'injected failure'); END",
    );
    const receipt = db.prepare(
      'INSERT INTO jito_sign_receipts VALUES(?,?,?,?,?,?,?,?,?,?)',
    );
    expect(() =>
      receipt.run(
        'owner',
        f.manifest.id,
        0,
        attempt,
        f.manifest.sha256,
        r.wallet,
        r.id,
        'synthetic-transaction',
        'synthetic-signature',
        now,
      ),
    ).toThrow('injected failure');
    expect(
      db
        .prepare('SELECT state,signature FROM imported_swap_signing_intents')
        .get(),
    ).toMatchObject({ state: 'awaiting_signature', signature: null });
    expect(
      db.prepare('SELECT count(*) AS n FROM jito_sign_receipts').get()?.n,
    ).toBe(0);
    db.exec('DROP TRIGGER fixture_full_fail_packet');
    receipt.run(
      'owner',
      f.manifest.id,
      0,
      attempt,
      f.manifest.sha256,
      r.wallet,
      r.id,
      'synthetic-transaction',
      'synthetic-signature',
      now,
    );
    expect(
      db.prepare('SELECT state FROM solana_execution_reservations').get()
        ?.state,
    ).toBe('signed');
    const tip = crypto.randomUUID();
    db.prepare('INSERT INTO jito_sign_attempts VALUES(?,?,?,?,?,?,?,?)').run(
      'owner',
      f.manifest.id,
      1,
      tip,
      f.manifest.sha256,
      r.wallet,
      null,
      now,
    );
    receipt.run(
      'owner',
      f.manifest.id,
      1,
      tip,
      f.manifest.sha256,
      r.wallet,
      null,
      'synthetic-tip',
      'synthetic-tip-signature',
      now,
    );
    expect(
      db
        .prepare(
          'SELECT count(*) AS n FROM jito_bundle_packets WHERE signature IS NOT NULL',
        )
        .get()?.n,
    ).toBe(2);
  } finally {
    db.close();
  }
});

async function fixture(legacy = false, wallets = 1) {
  const f = await jitoBundleFixture(wallets);
  const d = jitoDatabase(f.manifest);
  databases.push(d);
  d.sqlite.exec(
    'CREATE TABLE solana_execution_reservations(owner_id TEXT NOT NULL,wallet_address TEXT NOT NULL,scope TEXT NOT NULL,intent_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(owner_id,wallet_address))',
  );
  d.sqlite.exec(
    'INSERT INTO solana_execution_reservations SELECT owner_id,wallet_address,scope,intent_id,state FROM solana_swap_reservations',
  );
  d.sqlite.exec(
    'CREATE TRIGGER fixture_execution_update AFTER UPDATE OF state ON solana_swap_reservations BEGIN UPDATE solana_execution_reservations SET state=NEW.state WHERE owner_id=NEW.owner_id AND wallet_address=NEW.wallet_address; END',
  );
  if (legacy) d.attach();
  d.sqlite.exec(migration);
  if (!legacy) {
    d.sqlite
      .prepare("INSERT INTO jito_bundles VALUES(?,?,?,?,?,'reviewed',NULL,?,?)")
      .run(
        'owner',
        f.manifest.id,
        f.manifest.projectId,
        f.manifest.sessionId,
        JSON.stringify(f.manifest),
        f.manifest.createdAt,
        f.manifest.createdAt,
      );
    d.sqlite
      .prepare('INSERT INTO jito_bundle_protocol VALUES(?,?,?,?,?)')
      .run('owner', f.manifest.id, 2, f.manifest.sha256, f.manifest.createdAt);
    for (let i = 0; i <= f.manifest.swaps.length; i++)
      d.sqlite
        .prepare('INSERT INTO jito_bundle_packets VALUES(?,?,?,?,NULL,NULL)')
        .run('owner', f.manifest.id, i, f.manifest.swaps[i]?.id ?? null);
  }
  return { ...f, ...d };
}
function begin(
  f: Awaited<ReturnType<typeof fixture>>,
  packet = 0,
  nonce = crypto.randomUUID(),
) {
  const swap = f.manifest.swaps[packet];
  f.sqlite
    .prepare('INSERT INTO jito_sign_attempts VALUES(?,?,?,?,?,?,?,?)')
    .run(
      'owner',
      f.manifest.id,
      packet,
      nonce,
      f.manifest.sha256,
      swap?.wallet ?? f.manifest.tip.wallet,
      swap?.id ?? null,
      new Date().toISOString(),
    );
  return nonce;
}
function receipt(
  f: Awaited<ReturnType<typeof fixture>>,
  packet: number,
  nonce: string,
  transaction: string,
  signature: string,
) {
  const swap = f.manifest.swaps[packet];
  return f.sqlite
    .prepare('INSERT INTO jito_sign_receipts VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(
      'owner',
      f.manifest.id,
      packet,
      nonce,
      f.manifest.sha256,
      swap?.wallet ?? f.manifest.tip.wallet,
      swap?.id ?? null,
      transaction,
      signature,
      new Date().toISOString(),
    );
}

it('quarantines pre-existing bundles while retaining owned history and reservations', async () => {
  const f = await fixture(true);
  expect(
    f.sqlite
      .prepare('SELECT document FROM jito_bundles WHERE owner_id=? AND id=?')
      .get('owner', f.manifest.id),
  ).toBeTruthy();
  expect(() =>
    f.sqlite
      .prepare('INSERT INTO jito_bundle_protocol VALUES(?,?,?,?,?)')
      .run('owner', f.manifest.id, 2, f.manifest.sha256, f.manifest.createdAt),
  ).toThrow();
  for (const state of ['cancelled', 'expired', 'submitting'])
    expect(() =>
      f.sqlite.prepare('UPDATE jito_bundles SET state=?').run(state),
    ).toThrow('recovery');
  expect(() =>
    f.sqlite.prepare('DELETE FROM solana_swap_reservations').run(),
  ).toThrow();
  expect(() =>
    f.sqlite.prepare('DELETE FROM solana_execution_reservations').run(),
  ).toThrow();
  expect(() => begin(f)).toThrow();
});
it('retains UNKNOWN across conflicts and only resolves through matching receipt insertion', async () => {
  const f = await fixture();
  const nonce = begin(f);
  expect(() => begin(f, 1)).toThrow('unknown');
  for (const state of ['cancelled', 'expired', 'submitting'])
    expect(() =>
      f.sqlite.prepare('UPDATE jito_bundles SET state=?').run(state),
    ).toThrow('recovery');
  expect(() =>
    f.sqlite.prepare('DELETE FROM solana_swap_reservations').run(),
  ).toThrow();
  expect(() =>
    f.sqlite.prepare('DELETE FROM solana_execution_reservations').run(),
  ).toThrow();
  expect(() =>
    f.sqlite
      .prepare('UPDATE imported_swap_signing_intents SET state=?,signature=?')
      .run('signed', 'signature'),
  ).toThrow();
  expect(() =>
    receipt(f, 0, crypto.randomUUID(), 'encoded', 'signature'),
  ).toThrow();
  expect(
    f.sqlite.prepare('SELECT COUNT(*) AS n FROM jito_sign_receipts').get()?.n,
  ).toBe(0);
  receipt(f, 0, nonce, 'encoded', 'signature');
  expect(
    f.sqlite
      .prepare('SELECT state,signature FROM imported_swap_signing_intents')
      .get(),
  ).toMatchObject({ state: 'signed', signature: 'signature' });
  expect(
    f.sqlite
      .prepare(
        'SELECT signature,`transaction` AS tx FROM jito_bundle_packets WHERE packet=0',
      )
      .get(),
  ).toMatchObject({ signature: 'signature', tx: 'encoded' });
  expect(() =>
    f.sqlite.prepare('DELETE FROM jito_sign_attempts').run(),
  ).toThrow();
  expect(() =>
    f.sqlite.prepare('DELETE FROM jito_sign_receipts').run(),
  ).toThrow();
  expect(() =>
    f.sqlite.prepare('DELETE FROM jito_bundle_packets').run(),
  ).toThrow();
  expect(() => f.sqlite.prepare('DELETE FROM jito_bundles').run()).toThrow();
  const tipNonce = begin(f, 1);
  receipt(f, 1, tipNonce, 'tip-encoded', 'tip-signature');
  expect(
    f.sqlite
      .prepare('SELECT signature FROM jito_bundle_packets WHERE packet=1')
      .get()?.signature,
  ).toBe('tip-signature');
});
it('keeps every linked wallet reservation unchanged while another packet is UNKNOWN', async () => {
  const f = await fixture(false, 2);
  begin(f, 0);
  const other = f.manifest.swaps[1].wallet;
  for (const table of [
    'solana_swap_reservations',
    'solana_execution_reservations',
  ]) {
    expect(() =>
      f.sqlite
        .prepare(
          `UPDATE ${table} SET state='signed' WHERE owner_id=? AND wallet_address=?`,
        )
        .run('owner', other),
    ).toThrow('retained');
    expect(() =>
      f.sqlite
        .prepare(`DELETE FROM ${table} WHERE owner_id=? AND wallet_address=?`)
        .run('owner', other),
    ).toThrow('retained');
  }
});
it('rolls back receipt and intent when packet application aborts', async () => {
  const f = await fixture();
  const nonce = begin(f);
  f.sqlite.exec(
    "CREATE TRIGGER fixture_fail_packet BEFORE UPDATE OF signature ON jito_bundle_packets BEGIN SELECT RAISE(ABORT,'injected failure'); END",
  );
  expect(() => receipt(f, 0, nonce, 'encoded', 'signature')).toThrow(
    'injected failure',
  );
  expect(
    f.sqlite.prepare('SELECT COUNT(*) AS n FROM jito_sign_receipts').get()?.n,
  ).toBe(0);
  expect(
    f.sqlite
      .prepare('SELECT state,signature FROM imported_swap_signing_intents')
      .get(),
  ).toMatchObject({ state: 'awaiting_signature', signature: null });
  expect(() =>
    f.sqlite.prepare("UPDATE jito_bundles SET state='cancelled'").run(),
  ).toThrow('recovery');
});
it('refuses legacy writers lacking a protocol marker', async () => {
  const f = await fixture();
  const old = crypto.randomUUID();
  const doc = JSON.stringify({ ...f.manifest, id: old });
  f.sqlite
    .prepare("INSERT INTO jito_bundles VALUES(?,?,?,?,?,'reviewed',NULL,?,?)")
    .run(
      'owner',
      old,
      f.manifest.projectId,
      f.manifest.sessionId,
      doc,
      f.manifest.createdAt,
      f.manifest.createdAt,
    );
  expect(() =>
    f.sqlite
      .prepare('INSERT INTO jito_bundle_packets VALUES(?,?,?,?,NULL,NULL)')
      .run('owner', old, 0, f.review.id),
  ).toThrow('upgrade');
});
it('binds the exact owner, hash, signer, packet, intent and current tip-payer context', async () => {
  const f = await fixture();
  const args = [
    'owner',
    f.manifest.id,
    0,
    crypto.randomUUID(),
    f.manifest.sha256,
    f.review.wallet,
    f.review.id,
    new Date().toISOString(),
  ];
  const insert = f.sqlite.prepare(
    'INSERT INTO jito_sign_attempts VALUES(?,?,?,?,?,?,?,?)',
  );
  for (const [index, value] of [
    [0, 'other'],
    [2, 1],
    [4, 'a'.repeat(64)],
    [5, 'wrong-wallet'],
    [6, crypto.randomUUID()],
  ] as const) {
    const bad = [...args];
    bad[index] = value;
    expect(() => insert.run(...bad)).toThrow();
  }
  f.sqlite.prepare('UPDATE workspace_wallets SET revision=2').run();
  expect(() => begin(f, 1)).toThrow('context');
  f.sqlite.prepare('UPDATE workspace_wallets SET revision=1').run();
  f.sqlite
    .prepare('UPDATE solana_execution_reservations SET intent_id=?')
    .run('wrong-intent');
  expect(() => begin(f, 1)).toThrow('context');
});
