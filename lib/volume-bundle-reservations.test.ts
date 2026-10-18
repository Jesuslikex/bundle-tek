import { afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createClient, type Client } from '@libsql/client';
import { createTursoDatabase } from '../db/turso';
import { volumeProgramFixture } from '../test/volume-program-fixture';
import {
  createVolumeBundleSession,
  reserveVolumeBundleRound,
  readVolumeBundleReservation,
  readVolumeBundleTipBudget,
  cancelVolumeBundleReservation,
  markVolumeBundleAttempted,
} from './volume-bundle-reservations';
const clients: Client[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});
async function fixture(atMs?: number) {
  const f = await volumeProgramFixture(atMs),
    client = createClient({ url: 'file::memory:' });
  clients.push(client);
  // Real libSQL+production adapter and our complete migration. Narrow parent doubles isolate reciprocal guards.
  for (const sql of [
    'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,revision INTEGER,archived INTEGER,chain TEXT,document TEXT)',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
    'CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT)',
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT,scope TEXT,intent_id TEXT,state TEXT)',
    'CREATE TABLE volume_bot_sessions(id TEXT,owner_id TEXT,plan TEXT,state TEXT)',
    'CREATE TABLE volume_bot_batches(id TEXT,session_id TEXT)',
    'CREATE TABLE volume_bot_trades(batch_id TEXT,state TEXT)',
    'CREATE TABLE pump_organic_sequences(id TEXT,owner_id TEXT,plan TEXT,state TEXT)',
    'CREATE TABLE pump_organic_batches(id TEXT,sequence_id TEXT)',
    'CREATE TABLE pump_organic_buys(batch_id TEXT,state TEXT)',
    'CREATE TABLE pump_launch_reviews(id TEXT,owner_id TEXT,payer TEXT,review TEXT,state TEXT)',
    'CREATE TABLE pair_order_executions(owner_id TEXT,wallet TEXT,state TEXT)',
    'CREATE TABLE token_supply_actions(owner_id TEXT,wallet_address TEXT,state TEXT)',
    'CREATE TABLE counter_proposal_reservations(owner_id TEXT,wallet_address TEXT,approval_id TEXT,expires_at TEXT)',
  ])
    await client.execute(sql);
  for (const sql of readFileSync(
    'drizzle/0105_volume_bundle_reservations.sql',
    'utf8',
  ).split('--> statement-breakpoint'))
    if (sql.trim()) await client.execute(sql);
  await client.execute({
    sql: "INSERT INTO imported_token_projects VALUES('owner',?,1,0,'Solana',?)",
    args: [
      f.input.projectId,
      JSON.stringify({ token: { address: f.input.mint } }),
    ],
  });
  await client.execute({
    sql: "INSERT INTO workspace_wallets VALUES('owner','Solana',?,1,0)",
    args: [f.review.wallet],
  });
  await client.execute({
    sql: "INSERT INTO wallet_ownership_proofs VALUES('owner','Solana',?)",
    args: [f.review.wallet],
  });
  const db = createTursoDatabase(client),
    sessionInput = {
      id: f.input.sessionId,
      projectId: f.input.projectId,
      projectRevision: 1,
      mint: f.input.mint,
      plan: f.input.plan,
      wallets: [{ address: f.review.wallet, revision: 1 }],
    };
  const saved = await createVolumeBundleSession(db, 'owner', sessionInput);
  const request = {
    id: crypto.randomUUID(),
    sessionId: saved.id,
    sessionRevision: 1,
    walletRevision: 1,
    construction: f.review,
    route: f.route,
  };
  const deps = {
    rpc: f.rpc,
    policy: f.policy,
    minimumSlot: 1000,
    now: () => f.nowMs,
  };
  return {
    ...f,
    client,
    db,
    saved,
    sessionInput,
    request,
    deps,
    reserve: () =>
      reserveVolumeBundleRound(
        db,
        'owner',
        request,
        deps,
        new AbortController().signal,
      ),
  };
}
it('durably reserves one round/cap, replays idempotently, isolates owners and explicitly cancels unsigned holds', async () => {
  const f = await fixture();
  const held = await f.reserve();
  expect(held).toMatchObject({
    state: 'held',
    tipCapLamports: '100000',
    signingAllowed: false,
    executionAllowed: false,
  });
  const count = f.calls.length;
  expect(await f.reserve()).toEqual(held);
  expect(f.calls).toHaveLength(count);
  expect(
    await readVolumeBundleReservation(f.db, 'other', f.request.id),
  ).toBeNull();
  expect(
    await readVolumeBundleTipBudget(f.db, 'owner', f.saved.id),
  ).toMatchObject({ heldLamports: '100000', availableLamports: '900000' });
  await expect(
    cancelVolumeBundleReservation(f.db, 'other', f.request.id),
  ).rejects.toThrow();
  expect(
    (await cancelVolumeBundleReservation(f.db, 'owner', f.request.id))?.state,
  ).toBe('cancelled');
  expect(
    await readVolumeBundleTipBudget(f.db, 'owner', f.saved.id),
  ).toMatchObject({ heldLamports: '0', availableLamports: '1000000' });
  expect(
    (
      await f.client.execute(
        'SELECT state FROM volume_bundle_reservation_events ORDER BY sequence',
      )
    ).rows.map((r) => r.state),
  ).toEqual(['held', 'cancelled']);
});
it('arbitrates concurrent requests atomically and refuses changed idempotency context', async () => {
  const f = await fixture();
  const second = { ...f.request, id: crypto.randomUUID() };
  const results = await Promise.allSettled([
    f.reserve(),
    reserveVolumeBundleRound(
      f.db,
      'owner',
      second,
      f.deps,
      new AbortController().signal,
    ),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM volume_bundle_reservations',
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (await readVolumeBundleTipBudget(f.db, 'owner', f.saved.id)).heldLamports,
  ).toBe('100000');
  const id = (
    await f.client.execute('SELECT id FROM volume_bundle_reservations')
  ).rows[0].id;
  if (typeof id !== 'string')
    throw new Error('Synthetic row identity required');
  await expect(
    reserveVolumeBundleRound(
      f.db,
      'owner',
      { ...f.request, id, walletRevision: 2 },
      f.deps,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it('denies default pins and caller-provided proof fields without writes', async () => {
  const f = await fixture();
  await expect(
    reserveVolumeBundleRound(
      f.db,
      'owner',
      f.request,
      { ...f.deps, policy: null },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/separately reviewed/);
  await expect(
    reserveVolumeBundleRound(
      f.db,
      'owner',
      { ...f.request, simulation: {} } as typeof f.request,
      f.deps,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM volume_bundle_reservations',
      )
    ).rows[0].n,
  ).toBe(0);
});
it('returns one durable identity for concurrent exact retries and arbitrates cancel versus attempt', async () => {
  const f = await fixture();
  const results = await Promise.all([f.reserve(), f.reserve()]);
  expect(results[0]?.id).toBe(results[1]?.id);
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM volume_bundle_reservation_events',
      )
    ).rows[0].n,
  ).toBe(1);
  const race = await Promise.allSettled([
    cancelVolumeBundleReservation(f.db, 'owner', f.request.id),
    markVolumeBundleAttempted(f.db, 'owner', f.request.id, crypto.randomUUID()),
  ]);
  expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const final = await readVolumeBundleReservation(f.db, 'owner', f.request.id);
  expect(
    (await readVolumeBundleTipBudget(f.db, 'owner', f.saved.id)).heldLamports,
  ).toBe(final?.state === 'attempted' ? '100000' : '0');
});
it.each(['project', 'wallet', 'proof'])(
  'rechecks changed %s at the exact insert after successful runtime',
  async (kind) => {
    const f = await fixture();
    let scans = 0;
    const rpc: typeof f.rpc = async (method, params, signal) => {
      const raw = await f.rpc(method, params, signal);
      if (
        method === 'getMultipleAccounts' &&
        (params[1] as { dataSlice?: unknown }).dataSlice &&
        ++scans === 9
      ) {
        await f.client.execute(
          kind === 'project'
            ? 'UPDATE imported_token_projects SET revision=2'
            : kind === 'wallet'
              ? 'UPDATE workspace_wallets SET revision=2'
              : 'DELETE FROM wallet_ownership_proofs',
        );
      }
      return raw;
    };
    // First scan has six account reads; the ninth sliced read belongs to the final scan.
    await expect(
      reserveVolumeBundleRound(
        f.db,
        'owner',
        f.request,
        { ...f.deps, rpc },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(scans).toBeGreaterThanOrEqual(9);
    expect(
      f.calls.filter((c) => c.method === 'simulateTransaction'),
    ).toHaveLength(1);
    expect(
      (
        await f.client.execute(
          'SELECT count(*) AS n FROM volume_bundle_reservations',
        )
      ).rows[0].n,
    ).toBe(0);
  },
);
it('retains attempted holds across expiry, refuses cancellation/retry and keeps audit evidence immutable', async () => {
  const f = await fixture(Math.floor(Date.now() / 1000) * 1000 - 28000);
  await f.reserve();
  const attempt = crypto.randomUUID();
  expect(
    (await markVolumeBundleAttempted(f.db, 'owner', f.request.id, attempt))
      ?.state,
  ).toBe('attempted');
  expect(
    (await markVolumeBundleAttempted(f.db, 'owner', f.request.id, attempt))
      ?.attemptId,
  ).toBe(attempt);
  await new Promise((r) => setTimeout(r, 3100));
  expect(
    (await readVolumeBundleTipBudget(f.db, 'owner', f.saved.id)).heldLamports,
  ).toBe('100000');
  await expect(
    cancelVolumeBundleReservation(f.db, 'owner', f.request.id),
  ).rejects.toThrow();
  await expect(
    f.client.execute("UPDATE volume_bundle_reservations SET state='held'"),
  ).rejects.toThrow();
  await expect(
    f.client.execute('DELETE FROM volume_bundle_reservations'),
  ).rejects.toThrow();
  await expect(
    f.client.execute(
      "UPDATE volume_bundle_reservation_events SET state='cancelled'",
    ),
  ).rejects.toThrow();
  await expect(
    f.client.execute('UPDATE volume_bundle_sessions SET tip_budget=99999999'),
  ).rejects.toThrow();
});
it('keeps expired unsigned caps held until explicit cancellation, even after project archival', async () => {
  const f = await fixture(Math.floor(Date.now() / 1000) * 1000 - 28000);
  await f.reserve();
  await new Promise((r) => setTimeout(r, 3100));
  expect(
    (await readVolumeBundleTipBudget(f.db, 'owner', f.saved.id)).heldLamports,
  ).toBe('100000');
  await expect(
    markVolumeBundleAttempted(f.db, 'owner', f.request.id, crypto.randomUUID()),
  ).rejects.toThrow();
  await f.client.execute('UPDATE imported_token_projects SET archived=1');
  expect(
    (await cancelVolumeBundleReservation(f.db, 'owner', f.request.id))?.state,
  ).toBe('cancelled');
});
it('refuses an attempt marker after wallet revision drift while allowing unsigned cleanup', async () => {
  const f = await fixture();
  await f.reserve();
  await f.client.execute('UPDATE workspace_wallets SET revision=2');
  await expect(
    markVolumeBundleAttempted(f.db, 'owner', f.request.id, crypto.randomUUID()),
  ).rejects.toThrow();
  expect(
    (await cancelVolumeBundleReservation(f.db, 'owner', f.request.id))?.state,
  ).toBe('cancelled');
});
it.each([
  'shared',
  'scheduled',
  'organic',
  'launch',
  'pair',
  'supply',
  'counter',
])('blocks %s activation or wallet substitution by update', async (kind) => {
  const f = await fixture(),
    w = f.review.wallet;
  const specs: Record<
    string,
    { insert: string; args: string[]; update: string; updateArgs: string[] }
  > = {
    shared: {
      insert:
        "INSERT INTO solana_execution_reservations VALUES('owner','other','warmup','x','awaiting_signature')",
      args: [],
      update: 'UPDATE solana_execution_reservations SET wallet_address=?',
      updateArgs: [w],
    },
    scheduled: {
      insert:
        "INSERT INTO volume_bot_sessions VALUES('v','owner',?,'cancelled')",
      args: [JSON.stringify({ wallets: [w] })],
      update: "UPDATE volume_bot_sessions SET state='active'",
      updateArgs: [],
    },
    organic: {
      insert:
        "INSERT INTO pump_organic_sequences VALUES('o','owner',?,'cancelled')",
      args: [JSON.stringify({ rows: [{ address: w }] })],
      update: "UPDATE pump_organic_sequences SET state='active'",
      updateArgs: [],
    },
    launch: {
      insert:
        "INSERT INTO pump_launch_reviews VALUES('p','owner',?,'{}','cancelled')",
      args: [w],
      update: "UPDATE pump_launch_reviews SET state='review'",
      updateArgs: [],
    },
    pair: {
      insert: "INSERT INTO pair_order_executions VALUES('owner',?,'failed')",
      args: [w],
      update: "UPDATE pair_order_executions SET state='reserved'",
      updateArgs: [],
    },
    supply: {
      insert: "INSERT INTO token_supply_actions VALUES('owner',?,'cancelled')",
      args: [w],
      update: "UPDATE token_supply_actions SET state='signing'",
      updateArgs: [],
    },
    counter: {
      insert:
        "INSERT INTO counter_proposal_reservations VALUES('owner',?,NULL,'2000-01-01T00:00:00.000Z')",
      args: [w],
      update: "UPDATE counter_proposal_reservations SET approval_id='a'",
      updateArgs: [],
    },
  };
  const s = specs[kind];
  await f.client.execute({ sql: s.insert, args: s.args });
  await f.reserve();
  await expect(
    f.client.execute({ sql: s.update, args: s.updateArgs }),
  ).rejects.toThrow(/same-block Volume/);
});
it.each([
  'shared',
  'scheduled',
  'organic',
  'launch',
  'pair',
  'supply',
  'counter',
])('blocks %s both before and after a same-block hold', async (kind) => {
  const f = await fixture(),
    w = f.review.wallet;
  const specs: Record<string, { sql: string; args: string[]; remove: string }> =
    {
      shared: {
        sql: "INSERT INTO solana_execution_reservations VALUES('owner',?,'warmup','x','awaiting_signature')",
        args: [w],
        remove: 'DELETE FROM solana_execution_reservations',
      },
      scheduled: {
        sql: "INSERT INTO volume_bot_sessions VALUES('v','owner',?,'active')",
        args: [JSON.stringify({ wallets: [w] })],
        remove: 'DELETE FROM volume_bot_sessions',
      },
      organic: {
        sql: "INSERT INTO pump_organic_sequences VALUES('o','owner',?,'active')",
        args: [JSON.stringify({ rows: [{ address: w }] })],
        remove: 'DELETE FROM pump_organic_sequences',
      },
      launch: {
        sql: "INSERT INTO pump_launch_reviews VALUES('p','owner',?,'{}','review')",
        args: [w],
        remove: 'DELETE FROM pump_launch_reviews',
      },
      pair: {
        sql: "INSERT INTO pair_order_executions VALUES('owner',?,'reserved')",
        args: [w],
        remove: 'DELETE FROM pair_order_executions',
      },
      supply: {
        sql: "INSERT INTO token_supply_actions VALUES('owner',?,'awaiting_signature')",
        args: [w],
        remove: 'DELETE FROM token_supply_actions',
      },
      counter: {
        sql: "INSERT INTO counter_proposal_reservations VALUES('owner',?,'a','2099-01-01T00:00:00.000Z')",
        args: [w],
        remove: 'DELETE FROM counter_proposal_reservations',
      },
    };
  const s = specs[kind];
  await f.client.execute(s);
  await expect(f.reserve()).rejects.toThrow(/already reserved/);
  await f.client.execute(s.remove);
  await f.reserve();
  await expect(f.client.execute(s)).rejects.toThrow(/same-block Volume/);
  await cancelVolumeBundleReservation(f.db, 'owner', f.request.id);
  await expect(f.client.execute(s)).resolves.toBeDefined();
});
