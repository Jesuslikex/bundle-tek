import { expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { warmupV2RuntimeFixture } from '@/test/warmup-session-v2-runtime-fixture';
import { WARMUP_RUNTIME_PARENT_FIXTURE_SQL } from '@/test/warmup-runtime-wallet-busy-fixture';
import {
  prepareWalletWarmupV2RuntimeAttempt as prepare,
  prepareWalletWarmupV2Attempt as preview,
} from './wallet-warmup-session-v2-attempts';
import { createWalletWarmupV2Provider } from './wallet-warmup-session-v2-provider';
import { WARMUP_RUNTIME_WALLET_BUSY_SQL as busy } from './wallet-warmup-runtime-wallet-busy';
type Fixture = Awaited<ReturnType<typeof warmupV2RuntimeFixture>>;
const signal = () => new AbortController().signal;
const request = (f: Fixture, input = f.selection(), db = f.db) =>
  prepare(db, 'owner', input, true, signal(), 'synthetic-key', f.factory);
async function counts(db: D1Database) {
  return Promise.all(
    [
      'wallet_warmup_session_v2_attempts',
      'wallet_warmup_session_v2_attempt_purposes',
      'wallet_balance_gates',
    ].map(
      async (t) =>
        (await db
          .prepare(`SELECT count(*) AS n FROM ${t}`)
          .first<{ n: number }>())!.n,
    ),
  );
}
it.each([
  'pair',
  'launch',
  'volume',
  'bundle',
  'cleanup',
  'supply',
  'nuke',
  'counter',
  'organic',
] as const)(
  'preflights an active %s without spending an attempt, purpose or cooldown',
  async (kind) => {
    const f = await warmupV2RuntimeFixture();
    try {
      const before = await counts(f.db),
        wallet = f.packets.wallet;
      if (kind === 'pair')
        await f.db
          .prepare('INSERT INTO pair_order_executions VALUES(?,?,?)')
          .bind('owner', wallet, 'reserved')
          .run();
      if (kind === 'launch')
        await f.db
          .prepare('INSERT INTO pump_launch_reviews VALUES(?,?,?,?)')
          .bind('owner', wallet, 'review', '{}')
          .run();
      if (kind === 'volume')
        await f.db
          .prepare(
            'INSERT INTO volume_bot_sessions(owner_id,state,plan) VALUES(?,?,?)',
          )
          .bind('owner', 'active', JSON.stringify({ wallets: [wallet] }))
          .run();
      if (kind === 'bundle')
        await f.db
          .prepare(
            'INSERT INTO volume_bundle_reservations(owner_id,wallet,state) VALUES(?,?,?)',
          )
          .bind('owner', wallet, 'held')
          .run();
      if (kind === 'cleanup' || kind === 'supply')
        await f.db
          .prepare(
            `INSERT INTO ${kind === 'cleanup' ? 'wallet_cleanups' : 'token_supply_actions'} VALUES(?,?,?)`,
          )
          .bind('owner', wallet, 'signing')
          .run();
      if (kind === 'nuke')
        await f.db
          .prepare('INSERT INTO sniper_nuke_sells VALUES(?,?,?)')
          .bind('owner', wallet, 'submitting')
          .run();
      if (kind === 'counter')
        await f.db
          .prepare('INSERT INTO counter_proposal_reservations VALUES(?,?,?,?)')
          .bind('owner', wallet, 'approved', '2020-01-01T00:00:00.000Z')
          .run();
      if (kind === 'organic')
        await f.db
          .prepare('INSERT INTO pump_organic_sequences VALUES(?,?,?,?)')
          .bind(
            'owner',
            'active',
            JSON.stringify({ rows: [{ address: wallet }] }),
            'organic',
          )
          .run();
      const input = f.selection();
      await expect(request(f, input)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('active transaction work'),
      });
      await expect(request(f, input)).rejects.toMatchObject({ status: 409 });
      expect(await counts(f.db)).toEqual(before);
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.raw.prepare).not.toHaveBeenCalled();
      expect(f.raw.rpc).not.toHaveBeenCalled();
    } finally {
      f.client.close();
    }
  },
);
it('repeats the busy expression in the atomic lease batch, rolling back a racing purpose and gate', async () => {
  const f = await warmupV2RuntimeFixture();
  try {
    const before = await counts(f.db),
      input = f.selection();
    let raced = false;
    const db = Object.assign(Object.create(f.db) as D1Database, {
      batch: async (statements: D1PreparedStatement[]) => {
        if (
          !raced &&
          statements.some((s) =>
            (s as unknown as { sql: string }).sql.includes(
              'INSERT INTO wallet_warmup_session_v2_attempts',
            ),
          )
        ) {
          raced = true;
          await f.db
            .prepare('INSERT INTO pair_order_executions VALUES(?,?,?)')
            .bind('owner', f.packets.wallet, 'reserved')
            .run();
        }
        return f.db.batch(statements);
      },
    });
    await expect(request(f, input, db)).rejects.toMatchObject({ status: 409 });
    expect(raced).toBe(true);
    expect(await counts(f.db)).toEqual(before);
    expect(f.factory).not.toHaveBeenCalled();
    await f.db.prepare('DELETE FROM pair_order_executions').run();
    const recovered = await request(f, input, db);
    expect(recovered.lease.id).toBe(input.id);
    expect(recovered.lease.attempt_no).toBe(1);
    expect(recovered.outcome?.kind).toBe('prepared');
    expect(f.factory).toHaveBeenCalledOnce();
  } finally {
    f.client.close();
  }
});
it('refuses publication if another reservation appears during actual runtime work and recovers without rerunning', async () => {
  const f = await warmupV2RuntimeFixture();
  try {
    f.raw.prepare.mockImplementation(async () => {
      await f.db
        .prepare('INSERT INTO pair_order_executions VALUES(?,?,?)')
        .bind('owner', f.packets.wallet, 'signed')
        .run();
      return structuredClone(f.raw.order);
    });
    const input = f.selection(),
      saved = await request(f, input);
    expect(saved.outcome?.refusal_code).toBe('provider-refused');
    expect(f.raw.prepare).toHaveBeenCalledOnce();
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
});
it('fails closed on missing schema before claiming or calling providers', async () => {
  const f = await warmupV2RuntimeFixture();
  try {
    const before = await counts(f.db);
    await f.db.prepare('DROP TABLE pair_order_executions').run();
    await expect(request(f)).rejects.toMatchObject({ status: 503 });
    expect(await counts(f.db)).toEqual(before);
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.raw.rpc).not.toHaveBeenCalled();
  } finally {
    f.client.close();
  }
});
it('keeps ordinary preview independent of runtime-parent tables', async () => {
  const f = await warmupV2RuntimeFixture();
  try {
    await f.db.prepare('DROP TABLE pair_order_executions').run();
    const quote = vi.fn(async () => {
      throw Error('Synthetic quote reached');
    });
    const saved = await preview(
      f.db,
      'owner',
      f.selection(),
      true,
      signal(),
      'synthetic-key',
      (db, owner, key, lease) =>
        createWalletWarmupV2Provider(db, owner, key, lease, { quote }),
    );
    expect(quote).toHaveBeenCalledOnce();
    expect(saved.outcome?.kind).toBe('refused');
  } finally {
    f.client.close();
  }
});
it('reads positive and cancelled-but-in-flight rows from the full real migrated schema', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const entries = JSON.parse(
      readFileSync('drizzle/meta/_journal.json', 'utf8'),
    ).entries as { tag: string }[];
    for (const { tag } of entries)
      for (const sql of readFileSync(`drizzle/${tag}.sql`, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean))
        db.exec(sql);
    const check = () =>
      db
        .prepare(
          `SELECT ${busy} AS busy FROM (SELECT ? AS owner_id,? AS review_document) c`,
        )
        .get('owner', JSON.stringify({ wallets: [{ wallet: 'selected' }] }));
    expect(check()).toEqual({ busy: 0 });
    db.prepare(
      'INSERT INTO volume_bot_sessions(id,owner_id,project_id,project_revision,mint,decimals,plan,plan_sha256,state) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      'session',
      'owner',
      'project',
      1,
      'mint',
      6,
      JSON.stringify({ format: 'volume-bot-plan-v1', wallets: ['selected'] }),
      '0'.repeat(64),
      'active',
    );
    expect(check()).toEqual({ busy: 1 });
    db.prepare(
      'INSERT INTO volume_bot_batches(id,owner_id,session_id,batch,review,review_sha256,state,expires_at) VALUES(?,?,?,?,?,?,?,?)',
    ).run(
      'batch',
      'owner',
      'session',
      0,
      '{}',
      '0'.repeat(64),
      'signed',
      '2030-01-01T00:00:00.000Z',
    );
    db.prepare(
      'INSERT INTO volume_bot_trades(owner_id,batch_id,trade_index,round,side,wallet,signed,signature,state) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      'owner',
      'batch',
      0,
      0,
      'Buy',
      'selected',
      'synthetic-packet',
      'synthetic-signature',
      'submitted',
    );
    db.prepare(
      "UPDATE volume_bot_sessions SET state='cancelled' WHERE id='session'",
    ).run();
    expect(check()).toEqual({ busy: 1 });
    db.prepare(
      "UPDATE volume_bot_trades SET state='finalized' WHERE batch_id='batch'",
    ).run();
    expect(check()).toEqual({ busy: 0 });
  } finally {
    db.close();
  }
});
it.each([
  ['pair-reserved', 1],
  ['pair-signed', 1],
  ['pair-submitting', 1],
  ['pair-submitted', 1],
  ['pair-finalized', 0],
  ['pair-failed', 0],
  ['pair-expired', 0],
  ['launch-payer', 1],
  ['launch-holder', 1],
  ['launch-group-holder', 1],
  ['launch-none', 0],
  ['launch-group-none', 0],
  ['launch-missing-kind', 0],
  ['launch-finalized', 0],
  ['launch-cancelled', 0],
  ['launch-failed', 0],
  ['volume-active', 1],
  ['volume-complete', 0],
  ['volume-cancelled', 0],
  ['volume-cancelled-inflight', 1],
  ['volume-complete-inflight', 1],
  ['bundle-held', 1],
  ['bundle-attempted', 1],
  ['bundle-expired-held', 1],
  ['bundle-cancelled', 0],
  ['bundle-settled', 0],
  ['organic-active', 1],
  ['organic-stopped', 0],
  ['organic-stopped-inflight', 1],
  ['organic-complete-inflight', 1],
  ['cleanup-awaiting_signature', 1],
  ['cleanup-signing', 1],
  ['cleanup-signed', 1],
  ['cleanup-submitted', 1],
  ['cleanup-finalized', 0],
  ['cleanup-failed', 0],
  ['cleanup-cancelled', 0],
  ['supply-awaiting_signature', 1],
  ['supply-signing', 1],
  ['supply-signed', 1],
  ['supply-submitted', 1],
  ['supply-finalized', 0],
  ['supply-failed', 0],
  ['supply-cancelled', 0],
  ['nuke-review', 1],
  ['nuke-signed', 1],
  ['nuke-submitting', 1],
  ['nuke-submitted', 1],
  ['nuke-finalized', 0],
  ['nuke-failed', 0],
  ['nuke-expired', 0],
  ['nuke-cancelled', 0],
  ['counter-fresh', 1],
  ['counter-approved-expired', 1],
  ['counter-expired', 0],
  ['other-owner', 0],
  ['other-wallet', 0],
  ['second-selected-wallet', 1],
] as const)('read-side parent projection: %s', (kind, expected) => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const sql of WARMUP_RUNTIME_PARENT_FIXTURE_SQL) db.exec(sql);
    const wallet =
        kind === 'other-wallet'
          ? 'unselected'
          : kind === 'second-selected-wallet'
            ? 'second'
            : 'selected',
      owner = kind === 'other-owner' ? 'other' : 'owner';
    if (
      kind.startsWith('pair-') ||
      ['other-owner', 'other-wallet', 'second-selected-wallet'].includes(kind)
    )
      db.prepare('INSERT INTO pair_order_executions VALUES(?,?,?)').run(
        owner,
        wallet,
        kind.startsWith('pair-') ? kind.slice(5) : 'reserved',
      );
    if (kind.startsWith('launch-'))
      db.prepare('INSERT INTO pump_launch_reviews VALUES(?,?,?,?)').run(
        owner,
        kind === 'launch-payer' ? wallet : 'other',
        ['launch-finalized', 'launch-cancelled', 'launch-failed'].includes(kind)
          ? kind.slice(7)
          : 'review',
        JSON.stringify({
          format: kind.startsWith('launch-group')
            ? 'pump-launch-group-review-v1'
            : 'pump-create-holders-review-v1',
          input: {
            holders: [
              {
                ...(kind === 'launch-missing-kind'
                  ? {}
                  : { kind: kind.endsWith('none') ? 'none' : 'buy' }),
                address: wallet,
              },
            ],
          },
        }),
      );
    if (kind.startsWith('volume-')) {
      db.prepare('INSERT INTO volume_bot_sessions VALUES(?,?,?,?)').run(
        owner,
        kind.split('-')[1],
        JSON.stringify({ wallets: [wallet] }),
        'session',
      );
      if (kind.endsWith('inflight'))
        db.exec(
          "INSERT INTO volume_bot_batches(id,session_id) VALUES('batch','session'); INSERT INTO volume_bot_trades(batch_id,state) VALUES('batch','submitted')",
        );
    }
    if (kind.startsWith('bundle-'))
      db.prepare('INSERT INTO volume_bundle_reservations VALUES(?,?,?,?)').run(
        owner,
        wallet,
        kind === 'bundle-expired-held' ? 'held' : kind.slice(7),
        '2020-01-01T00:00:00.000Z',
      );
    if (kind.startsWith('organic-')) {
      db.prepare('INSERT INTO pump_organic_sequences VALUES(?,?,?,?)').run(
        owner,
        kind.split('-')[1],
        JSON.stringify({ rows: [{ address: wallet }] }),
        'sequence',
      );
      if (kind.endsWith('inflight'))
        db.exec(
          "INSERT INTO pump_organic_batches(id,sequence_id) VALUES('batch','sequence'); INSERT INTO pump_organic_buys(batch_id,state) VALUES('batch','submitted')",
        );
    }
    if (kind.startsWith('cleanup-') || kind.startsWith('supply-'))
      db.prepare(
        `INSERT INTO ${kind.startsWith('cleanup-') ? 'wallet_cleanups' : 'token_supply_actions'} VALUES(?,?,?)`,
      ).run(owner, wallet, kind.slice(kind.indexOf('-') + 1));
    if (kind.startsWith('nuke-'))
      db.prepare('INSERT INTO sniper_nuke_sells VALUES(?,?,?)').run(
        owner,
        wallet,
        kind.slice(5),
      );
    if (kind.startsWith('counter-'))
      db.prepare(
        'INSERT INTO counter_proposal_reservations VALUES(?,?,?,?)',
      ).run(
        owner,
        wallet,
        kind === 'counter-approved-expired' ? 'approved' : null,
        kind === 'counter-fresh'
          ? '2030-01-01T00:00:00.000Z'
          : '2020-01-01T00:00:00.000Z',
      );
    expect(
      db
        .prepare(
          `SELECT ${busy} AS busy FROM (SELECT ? AS owner_id,? AS review_document) c`,
        )
        .get(
          'owner',
          JSON.stringify({
            wallets: [{ wallet: 'selected' }, { wallet: 'second' }],
          }),
        ),
    ).toEqual({ busy: expected });
  } finally {
    db.close();
  }
});
