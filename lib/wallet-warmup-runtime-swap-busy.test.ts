import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { prepareWalletWarmupV2Attempt as preview } from './wallet-warmup-session-v2-attempts';
import { createWalletWarmupV2Provider } from './wallet-warmup-session-v2-provider';
import { WARMUP_RUNTIME_PARENT_FIXTURE_SQL } from '@/test/warmup-runtime-wallet-busy-fixture';
import { warmupV2RuntimeFixture } from '@/test/warmup-session-v2-runtime-fixture';
import { WARMUP_RUNTIME_WALLET_BUSY_SQL as busy } from './wallet-warmup-runtime-wallet-busy';
import { prepareWalletWarmupV2RuntimeAttempt as prepare } from './wallet-warmup-session-v2-attempts';
type Kind = 'imported' | 'warmup' | 'reservation' | 'execution';
const table = (kind: Kind) =>
  kind === 'execution'
    ? 'solana_execution_reservations'
    : kind === 'reservation'
      ? 'solana_swap_reservations'
      : kind === 'warmup'
        ? 'warmup_signing_intents'
        : 'imported_swap_signing_intents';
const active = ['awaiting_signature', 'signed', 'submitted'] as const;
it.each(
  (['imported', 'warmup'] as const).flatMap((kind) =>
    [...active, 'finalized', 'failed', 'cancelled'].map((state) => ({
      kind,
      state,
    })),
  ),
)(
  'read projection: $kind $state respects unresolved intent state',
  ({ kind, state }) => {
    const db = new DatabaseSync(':memory:');
    try {
      for (const sql of WARMUP_RUNTIME_PARENT_FIXTURE_SQL) db.exec(sql);
      db.prepare(
        `INSERT INTO ${table(kind)}(owner_id,wallet_address,state) VALUES(?,?,?)`,
      ).run('owner', 'selected', state);
      const result = db
        .prepare(
          `SELECT ${busy} AS busy FROM (SELECT ? AS owner_id,? AS review_document) c`,
        )
        .get('owner', JSON.stringify({ wallets: [{ wallet: 'selected' }] }));
      expect(result).toEqual({
        busy: active.includes(state as (typeof active)[number]) ? 1 : 0,
      });
    } finally {
      db.close();
    }
  },
);
it.each(
  (['imported', 'warmup'] as const).flatMap((kind) =>
    ['other-owner', 'other-wallet', 'second-selected'].map((scope) => ({
      kind,
      scope,
    })),
  ),
)('read projection: $kind $scope', ({ kind, scope }) => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const sql of WARMUP_RUNTIME_PARENT_FIXTURE_SQL) db.exec(sql);
    db.prepare(
      `INSERT INTO ${table(kind)}(owner_id,wallet_address,state) VALUES(?,?,?)`,
    ).run(
      scope === 'other-owner' ? 'other' : 'owner',
      scope === 'other-wallet'
        ? 'outside'
        : scope === 'second-selected'
          ? 'second'
          : 'selected',
      'signed',
    );
    const result = db
      .prepare(
        `SELECT ${busy} AS busy FROM (SELECT ? AS owner_id,? AS review_document) c`,
      )
      .get(
        'owner',
        JSON.stringify({
          wallets: [{ wallet: 'selected' }, { wallet: 'second' }],
        }),
      );
    expect(result).toEqual({ busy: scope === 'second-selected' ? 1 : 0 });
  } finally {
    db.close();
  }
});
async function insert(
  f: Awaited<ReturnType<typeof warmupV2RuntimeFixture>>,
  kind: Kind,
) {
  if (kind === 'warmup')
    await f.db
      .prepare(
        'INSERT INTO warmup_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        'synthetic-active',
        'owner',
        'synthetic-preparation',
        f.packets.wallet,
        JSON.stringify({ expiresAt: '2020-01-01T00:00:00.000Z' }),
        'awaiting_signature',
        '2020-01-01T00:00:00.000Z',
        '2020-01-01T00:00:00.000Z',
      )
      .run();
  else
    await f.db
      .prepare(
        `INSERT INTO ${table(kind)}(owner_id,wallet_address,state) VALUES(?,?,?)`,
      )
      .bind('owner', f.packets.wallet, 'submitted')
      .run();
}
const selectionCounts = (
  f: Awaited<ReturnType<typeof warmupV2RuntimeFixture>>,
) =>
  Promise.all(
    [
      'wallet_warmup_session_v2_attempts',
      'wallet_warmup_session_v2_attempt_purposes',
      'wallet_balance_gates',
    ].map(
      async (name) =>
        (await f.db
          .prepare(`SELECT count(*) AS n FROM ${name}`)
          .first<{ n: number }>())!.n,
    ),
  );
const request = (
  f: Awaited<ReturnType<typeof warmupV2RuntimeFixture>>,
  input = f.selection(),
  db = f.db,
) =>
  prepare(
    db,
    'owner',
    input,
    true,
    new AbortController().signal,
    'synthetic-key',
    f.factory,
  );
it.each(['imported', 'warmup', 'reservation', 'execution'] as const)(
  'preflights %s before spending an attempt or calling a provider',
  async (kind) => {
    const f = await warmupV2RuntimeFixture();
    try {
      const before = await selectionCounts(f);
      await insert(f, kind);
      await expect(request(f)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining(
          kind === 'reservation' || kind === 'execution'
            ? 'current owned warmup review changed'
            : 'active transaction work',
        ),
      });
      expect(await selectionCounts(f)).toEqual(before);
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.raw.rpc).not.toHaveBeenCalled();
    } finally {
      f.client.close();
    }
  },
);
it.each(['imported', 'warmup', 'reservation', 'execution'] as const)(
  'rolls back a racing %s conflict at the actual lease batch',
  async (kind) => {
    const f = await warmupV2RuntimeFixture();
    try {
      const before = await selectionCounts(f),
        input = f.selection();
      let raced = false;
      const db = Object.assign(Object.create(f.db) as D1Database, {
        batch: async (rows: D1PreparedStatement[]) => {
          if (
            !raced &&
            rows.some((r) =>
              (r as unknown as { sql: string }).sql.includes(
                'INSERT INTO wallet_warmup_session_v2_attempts',
              ),
            )
          ) {
            raced = true;
            await insert(f, kind);
          }
          return f.db.batch(rows);
        },
      });
      await expect(request(f, input, db)).rejects.toMatchObject({
        status: 409,
      });
      expect(raced).toBe(true);
      expect(await selectionCounts(f)).toEqual(before);
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.raw.rpc).not.toHaveBeenCalled();
    } finally {
      f.client.close();
    }
  },
);
it.each(['imported', 'warmup', 'reservation', 'execution'] as const)(
  'refuses publishing runtime evidence if %s appears during work, retaining same-ID recovery',
  async (kind) => {
    const f = await warmupV2RuntimeFixture();
    try {
      f.raw.prepare.mockImplementation(async () => {
        await insert(f, kind);
        return structuredClone(f.raw.order);
      });
      const input = f.selection(),
        saved = await request(f, input);
      if (kind === 'reservation' || kind === 'execution')
        expect(saved.outcome).toBeNull();
      else expect(saved.outcome?.refusal_code).toBe('provider-refused');
      expect(
        (await f.db
          .prepare(
            'SELECT count(*) AS n FROM wallet_warmup_session_v2_runtime_observations',
          )
          .first<{ n: number }>())!.n,
      ).toBe(0);
      expect((await request(f, input)).outcome).toEqual(saved.outcome);
      expect(f.factory).toHaveBeenCalledOnce();
    } finally {
      f.client.close();
    }
  },
);
it('reads positive orphan projections against actual migrated tables without changing their records', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const journal = JSON.parse(
      readFileSync('drizzle/meta/_journal.json', 'utf8'),
    ).entries as { tag: string }[];
    for (const { tag } of journal)
      for (const sql of readFileSync(`drizzle/${tag}.sql`, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean))
        db.exec(sql);
    expect(
      db
        .prepare(
          `SELECT ${busy} AS busy FROM (SELECT ? AS owner_id,? AS review_document) c`,
        )
        .get('owner', JSON.stringify({ wallets: [{ wallet: 'selected' }] })),
    ).toEqual({ busy: 0 });
    for (const name of [
      'imported_swap_signing_intents',
      'warmup_signing_intents',
      'solana_swap_reservations',
      'solana_execution_reservations',
    ])
      expect(db.prepare(`SELECT count(*) AS n FROM ${name}`).get()).toEqual({
        n: 0,
      });
    // Read-model fixture only: remove intent-table write triggers in this disposable
    // database to model legacy/inconsistent orphans. Production migrations and
    // reservation lifecycles are unchanged; this does not verify a signing path.
    for (const kind of ['imported', 'warmup'] as const) {
      const name = table(kind);
      for (const trigger of db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?",
        )
        .all(name))
        db.exec(`DROP TRIGGER "${String(trigger.name).replaceAll('"', '""')}"`);
      db.prepare(
        `INSERT INTO ${name}(id,owner_id,preparation_id,wallet_address,document,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
      ).run(
        `synthetic-${kind}`,
        'owner',
        'synthetic-preparation',
        'selected',
        '{}',
        'submitted',
        '2020-01-01',
        '2020-01-01',
      );
      const before = db.prepare(`SELECT * FROM ${name}`).all();
      const check = () =>
        db
          .prepare(
            `SELECT ${busy} AS busy FROM (SELECT ? AS owner_id,? AS review_document) c`,
          )
          .get('owner', JSON.stringify({ wallets: [{ wallet: 'selected' }] }));
      expect(check()).toEqual({ busy: 1 });
      expect(db.prepare(`SELECT * FROM ${name}`).all()).toEqual(before);
      expect(
        db.prepare('SELECT count(*) AS n FROM solana_swap_reservations').get(),
      ).toEqual({ n: 0 });
      db.prepare(`DELETE FROM ${name}`).run();
      expect(check()).toEqual({ busy: 0 });
    }
  } finally {
    db.close();
  }
});

it.each(['imported', 'warmup'] as const)(
  'missing %s intent schema refuses runtime before any lease or provider work',
  async (kind) => {
    const f = await warmupV2RuntimeFixture();
    try {
      const before = await selectionCounts(f);
      await f.db.prepare(`DROP TABLE ${table(kind)}`).run();
      await expect(request(f)).rejects.toMatchObject({ status: 503 });
      expect(await selectionCounts(f)).toEqual(before);
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.raw.rpc).not.toHaveBeenCalled();
    } finally {
      f.client.close();
    }
  },
);
it.each(['imported', 'warmup'] as const)(
  'ordinary preview stays independent of the new %s orphan-intent advisory',
  async (kind) => {
    const f = await warmupV2RuntimeFixture();
    try {
      await insert(f, kind);
      const quote = vi.fn(async () => {
        throw Error('Synthetic quote reached');
      });
      const saved = await preview(
        f.db,
        'owner',
        f.selection(),
        true,
        new AbortController().signal,
        'synthetic-key',
        (db, owner, key, lease) =>
          createWalletWarmupV2Provider(db, owner, key, lease, { quote }),
      );
      expect(quote).toHaveBeenCalledOnce();
      expect(saved.outcome?.kind).toBe('refused');
    } finally {
      f.client.close();
    }
  },
);
