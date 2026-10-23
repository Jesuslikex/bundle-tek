import { expect, it, vi } from 'vitest';
import { warmupV2RuntimeFixture } from '@/test/warmup-session-v2-runtime-fixture';
import {
  prepareWalletWarmupV2RuntimeAttempt as prepare,
  prepareWalletWarmupV2Attempt as preview,
} from './wallet-warmup-session-v2-attempts';
import { createWalletWarmupV2Provider } from './wallet-warmup-session-v2-provider';

type Fixture = Awaited<ReturnType<typeof warmupV2RuntimeFixture>>;
type Family = 'volume' | 'organic';
const signal = () => new AbortController().signal;
const request = (f: Fixture, input = f.selection(), db = f.db) =>
  prepare(db, 'owner', input, true, signal(), 'synthetic-key', f.factory);
async function counts(f: Fixture) {
  return Promise.all(
    [
      'wallet_warmup_session_v2_attempts',
      'wallet_warmup_session_v2_attempt_purposes',
      'wallet_balance_gates',
      'wallet_warmup_session_v2_runtime_observations',
    ].map(
      async (table) =>
        (await f.db
          .prepare(`SELECT count(*) AS n FROM ${table}`)
          .first<{ n: number }>())!.n,
    ),
  );
}
/** Legacy read-side projections exercise real attempt/service SQL. These rows
 * are not claimed reachable through post-0137 family admission; the separate
 * full-schema upgrade test establishes whether legacy rows can survive. */
async function hiddenChild(
  f: Fixture,
  family: Family,
  state: string,
  owner = 'owner',
) {
  if (family === 'volume') {
    await f.db
      .prepare(
        'INSERT INTO volume_bot_sessions(owner_id,state,plan,id) VALUES(?,?,?,?)',
      )
      .bind(
        owner,
        'cancelled',
        JSON.stringify({ wallets: [] }),
        'hidden-volume',
      )
      .run();
    await f.db
      .prepare('INSERT INTO volume_bot_batches(id,session_id) VALUES(?,?)')
      .bind('hidden-batch', 'hidden-volume')
      .run();
    await f.db
      .prepare(
        'INSERT INTO volume_bot_trades(batch_id,state,owner_id,wallet) VALUES(?,?,?,?)',
      )
      .bind('hidden-batch', state, owner, f.packets.wallet)
      .run();
  } else {
    await f.db
      .prepare(
        'INSERT INTO pump_organic_sequences(owner_id,state,plan,id) VALUES(?,?,?,?)',
      )
      .bind(owner, 'stopped', JSON.stringify({ rows: [] }), 'hidden-organic')
      .run();
    await f.db
      .prepare('INSERT INTO pump_organic_batches(id,sequence_id) VALUES(?,?)')
      .bind('hidden-batch', 'hidden-organic')
      .run();
    await f.db
      .prepare(
        'INSERT INTO pump_organic_buys(batch_id,state,owner_id,holder) VALUES(?,?,?,?)',
      )
      .bind('hidden-batch', state, owner, f.packets.wallet)
      .run();
  }
}
it.each(
  (['volume', 'organic'] as const).flatMap((family) =>
    (['signed', 'submitting', 'submitted'] as const).map((state) => ({
      family,
      state,
    })),
  ),
)(
  'preflights legacy hidden $family $state actual wallet child without claiming an attempt, purpose or cooldown',
  async ({ family, state }) => {
    const f = await warmupV2RuntimeFixture();
    try {
      const before = await counts(f);
      await hiddenChild(f, family, state);
      const input = f.selection();
      await expect(request(f, input)).rejects.toMatchObject({ status: 409 });
      await expect(request(f, input)).rejects.toMatchObject({ status: 409 });
      expect(await counts(f)).toEqual(before);
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.raw.prepare).not.toHaveBeenCalled();
      expect(f.raw.rpc).not.toHaveBeenCalled();
    } finally {
      f.client.close();
    }
  },
);
it.each(['volume', 'organic'] as const)(
  'atomically refuses a racing hidden %s child and rolls back purpose/gate/attempt before provider work',
  async (family) => {
    const f = await warmupV2RuntimeFixture();
    try {
      const before = await counts(f),
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
            await hiddenChild(f, family, 'submitted');
          }
          return f.db.batch(statements);
        },
      });
      await expect(request(f, input, db)).rejects.toMatchObject({
        status: 409,
      });
      expect(raced).toBe(true);
      expect(await counts(f)).toEqual(before);
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.raw.prepare).not.toHaveBeenCalled();
      expect(f.raw.rpc).not.toHaveBeenCalled();
    } finally {
      f.client.close();
    }
  },
);
it.each(['volume', 'organic'] as const)(
  'refuses runtime publication after a hidden %s child appears inside actual preparation and recovers the same refusal without another provider run',
  async (family) => {
    const f = await warmupV2RuntimeFixture();
    try {
      f.raw.prepare.mockImplementation(async () => {
        await hiddenChild(f, family, 'signed');
        return structuredClone(f.raw.order);
      });
      const input = f.selection(),
        saved = await request(f, input);
      expect(saved.outcome?.kind).toBe('refused');
      expect(saved.outcome?.refusal_code).toBe('provider-refused');
      expect(f.raw.prepare).toHaveBeenCalledOnce();
      expect(f.factory).toHaveBeenCalledOnce();
      const after = await counts(f);
      expect(after[3]).toBe(0);
      const rpcCalls = f.raw.rpc.mock.calls.length;
      const recovered = await request(f, input);
      expect(recovered.lease.id).toBe(input.id);
      expect(recovered.outcome).toEqual(saved.outcome);
      expect(await counts(f)).toEqual(after);
      expect(f.raw.rpc).toHaveBeenCalledTimes(rpcCalls);
      expect(f.raw.prepare).toHaveBeenCalledOnce();
      expect(f.factory).toHaveBeenCalledOnce();
    } finally {
      f.client.close();
    }
  },
);
it.each(['volume', 'organic'] as const)(
  'fails closed before claiming on a missing %s child identity column',
  async (family) => {
    const f = await warmupV2RuntimeFixture();
    try {
      const before = await counts(f);
      await f.db
        .prepare(
          family === 'volume'
            ? 'ALTER TABLE volume_bot_trades DROP COLUMN wallet'
            : 'ALTER TABLE pump_organic_buys DROP COLUMN holder',
        )
        .run();
      await expect(request(f)).rejects.toMatchObject({ status: 503 });
      expect(await counts(f)).toEqual(before);
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.raw.rpc).not.toHaveBeenCalled();
    } finally {
      f.client.close();
    }
  },
);
it('keeps the ordinary unsigned preview independent of new child-identity projections', async () => {
  const f = await warmupV2RuntimeFixture();
  try {
    await f.db
      .prepare('ALTER TABLE volume_bot_trades DROP COLUMN wallet')
      .run();
    const quote = vi.fn(async () => {
      throw Error('Synthetic ordinary quote reached');
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
    expect(f.raw.rpc).not.toHaveBeenCalled();
  } finally {
    f.client.close();
  }
});
