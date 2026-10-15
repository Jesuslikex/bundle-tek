import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Client } from '@libsql/client';
import { pumpOwnedGroupFixture } from '../test/pump-owned-group-fixture';
import { signSyntheticPumpGroup } from '../test/pump-group-synthetic-signatures';
import { preflightOwnedPumpCreate } from './owned-pump-preflight';
import {
  preparePumpLaunchGroupReview,
  approvePumpLaunchGroupReview,
  registerPumpLaunchGroupSignatures,
} from './pump-launch-group-review-service';
import {
  collectOwnedPumpGroupObservation,
  listOwnedPumpGroupObservations,
} from './pump-launch-group-observation-service';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import type { PumpLaunchGroupConsent } from './pump-launch-group-review';
vi.mock('./owned-pump-preflight', async (original) => ({
  ...(await original<typeof import('./owned-pump-preflight')>()),
  preflightOwnedPumpCreate: vi.fn(),
}));
const clients: Client[] = [];
const mocked = vi.mocked(preflightOwnedPumpCreate);
afterEach(() => {
  mocked.mockReset();
  for (const c of clients.splice(0)) c.close();
});
async function fixture(installed = true, approved = true, registered = false) {
  const f = await pumpOwnedGroupFixture(mocked, clients);
  await f.client.execute(
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT,scope TEXT,intent_id TEXT,state TEXT,PRIMARY KEY(owner_id,wallet_address))',
  );
  for (const file of [
    '0079_real_justice',
    '0081_pump_holder_reservations',
    '0082_pump_group_reviews',
    '0083_pump_group_approvals',
    '0084_pump_group_signatures',
    ...(installed ? ['0085_pump_group_observations'] : []),
  ])
    for (const sql of readFileSync(`drizzle/${file}.sql`, 'utf8').split(
      '--> statement-breakpoint',
    ))
      if (sql.trim()) await f.client.execute(sql);
  const signal = () => new AbortController().signal;
  const saved = await preparePumpLaunchGroupReview(
    f.db,
    'alice',
    f.terms,
    signal(),
    f.rpc,
  );
  const consent: PumpLaunchGroupConsent = {
    approved: true,
    reviewId: saved.review.id,
    manifestSha256: saved.review.manifestSha256,
    contextSha256: saved.review.contextSha256,
    simulationSha256: saved.review.simulationSha256,
    approvedScope: 'complete-create-developer-holder-packet-group',
    acknowledgeSimulationLimits: true,
  };
  if (approved)
    await approvePumpLaunchGroupReview(
      f.db,
      'alice',
      saved.review.id,
      consent,
      signal(),
      f.rpc,
    );
  const transactions = await signSyntheticPumpGroup(saved.review.packets, [
    f.f.f.payerSigner,
    f.f.f.mintSigner,
    ...f.holderSigners,
  ]);
  const register = () =>
    registerPumpLaunchGroupSignatures(
      f.db,
      'alice',
      saved.review.id,
      consent,
      transactions,
      signal(),
    );
  const signed = registered ? await register() : null;
  const calls: { method: string; params: unknown[] }[] = [];
  const last = BigInt(saved.review.input.create.lastValidBlockHeight);
  const state = {
    packets: transactions.map(() => null as unknown),
    height: last.toString(),
  };
  const rpc: PumpLaunchRpc = async (method, params, control) => {
    control.throwIfAborted();
    calls.push({ method, params });
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getEpochInfo')
      return {
        blockHeight: state.height,
        absoluteSlot: (last + 2000n).toString(),
      };
    if (method === 'getAccountInfo')
      return { context: { slot: (last + 2001n).toString() }, value: null };
    if (method === 'getTransaction') {
      const i = signed!.signedEvidence!.packets.findIndex(
        (p) => p.signature === params[0],
      );
      if (i < 0) throw new Error('Unexpected ID');
      return state.packets[i];
    }
    throw new Error('No other recovery methods permitted');
  };
  const collect = (
    provider = rpc,
    owner = 'alice',
    control = signal(),
    db = f.db,
  ) =>
    collectOwnedPumpGroupObservation(
      db,
      owner,
      saved.review.id,
      control,
      provider,
    );
  const rows = async () =>
    (await f.client.execute('SELECT * FROM pump_group_observations')).rows;
  return {
    ...f,
    saved,
    signed,
    state,
    calls,
    rpc,
    register,
    collect,
    rows,
    last,
  };
}
const columns = [
  'id',
  'owner_id',
  'review_id',
  'context_sha256',
  'manifest_sha256',
  'signed_group_sha256',
  'source_state',
  'observed_state',
  'sha256',
  'observation',
  'created_at',
];
function rawInsert(client: Client, row: Record<string, string | null>) {
  return client.execute({
    sql: `INSERT INTO pump_group_observations(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
    args: columns.map((key) => row[key]),
  });
}
it('persists approved unsigned observations, resumes immutable history and retains the original reservation state', async () => {
  const f = await fixture(),
    first = await f.collect();
  expect(first).toMatchObject({
    sourceState: 'approved',
    state: 'pending',
    receipt: {
      signatureKnown: false,
      signedGroupSha256: null,
      reservationsMustRemainHeld: true,
    },
  });
  expect(f.calls.some((c) => c.method === 'getTransaction')).toBe(false);
  f.state.height = (f.last + 33n).toString();
  const second = await f.collect();
  expect(second.state).toBe('expired-unobserved');
  const page = await listOwnedPumpGroupObservations(
    f.db,
    'alice',
    f.saved.review.id,
  );
  expect(page.observations).toHaveLength(2);
  expect(page.nextPosition).toBeNull();
  expect(new Set(page.observations.map((o) => o.sha256)).size).toBe(2);
  const parent = (
    await f.client.execute(
      'SELECT state,receipt,signed FROM pump_launch_reviews',
    )
  ).rows[0];
  expect(parent).toMatchObject({
    state: 'approved',
    receipt: null,
    signed: null,
  });
  await expect(
    f.client.execute("UPDATE pump_group_observations SET sha256='changed'"),
  ).rejects.toThrow('Immutable');
  await expect(
    f.client.execute('DELETE FROM pump_group_observations'),
  ).rejects.toThrow('history retained');
  await expect(
    f.client.execute({
      sql: 'INSERT INTO solana_execution_reservations VALUES(?,?,?,?,?)',
      args: ['alice', f.input.holders[0].address, 'warmup', 'busy', 'approved'],
    }),
  ).rejects.toThrow('reserved');
}, 60000);
it('binds signed partial and complete history to the exact immutable registered group without enabling a parent transition', async () => {
  const f = await fixture(true, true, true),
    evidence = f.signed!.signedEvidence!;
  const receipts = evidence.packets.map((p) => ({
    slot: '200',
    transaction: [p.transaction, 'base64'],
    meta: { err: null, fee: '5000' },
  }));
  f.state.packets[1] = receipts[1];
  const partial = await f.collect();
  expect(partial).toMatchObject({
    sourceState: 'signed',
    state: 'partial',
    receipt: {
      signedGroupSha256: evidence.signedGroupSha256,
      knownNetworkFeeRaw: '5000',
      networkFeeUnresolved: true,
    },
  });
  f.state.packets = receipts;
  const complete = await f.collect();
  expect(complete).toMatchObject({
    state: 'complete',
    receipt: {
      allPacketsSucceeded: true,
      completeLaunch: false,
      reservationsMustRemainHeld: true,
    },
  });
  expect(
    (await listOwnedPumpGroupObservations(f.db, 'alice', f.saved.review.id))
      .observations,
  ).toHaveLength(2);
  expect(
    (await f.client.execute('SELECT state,receipt FROM pump_launch_reviews'))
      .rows[0],
  ).toMatchObject({ state: 'signed', receipt: null });
  await expect(
    f.client.execute("UPDATE pump_launch_reviews SET state='finalized'"),
  ).rejects.toThrow('not enabled');
}, 60000);
it('rejects a foreign owner, missing approval and missing observation guards before provider reads', async () => {
  const f = await fixture(true, false);
  await expect(f.collect(f.rpc, 'bob')).rejects.toThrow('not found');
  await expect(f.collect()).rejects.toThrow('Recorded group approval');
  await expect(
    listOwnedPumpGroupObservations(f.db, 'bob', f.saved.review.id),
  ).rejects.toThrow('not found');
  expect(f.calls).toHaveLength(0);
  expect(await f.rows()).toHaveLength(0);
  const g = await fixture(false);
  await expect(g.collect()).rejects.toThrow('migration is not installed');
  expect(g.calls).toHaveLength(0);
}, 60000);
it('discards a stale unsigned observation when the parent is registered during the read', async () => {
  const f = await fixture();
  await expect(
    f.collect(async (method, params, signal) => {
      const value = await f.rpc(method, params, signal);
      if (method === 'getEpochInfo') await f.register();
      return value;
    }),
  ).rejects.toThrow('state changed during');
  expect(await f.rows()).toHaveLength(0);
  expect(
    (await f.client.execute('SELECT state FROM pump_launch_reviews')).rows[0]
      .state,
  ).toBe('signed');
}, 60000);
it('atomically rejects registration races at the insert boundary after the service recheck', async () => {
  const f = await fixture();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === 'bind')
          return (...args: unknown[]) => wrap(target.bind(...args));
        if (key === 'run')
          return async () => {
            await f.register();
            return target.run();
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const db = new Proxy(f.db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          return sql.startsWith('INSERT INTO pump_group_observations')
            ? wrap(statement)
            : statement;
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await expect(
    f.collect(f.rpc, 'alice', new AbortController().signal, db),
  ).rejects.toThrow('changed before storage');
  expect(await f.rows()).toHaveLength(0);
  expect(
    (await f.client.execute('SELECT state FROM pump_launch_reviews')).rows[0]
      .state,
  ).toBe('signed');
}, 60000);
it('rejects forged owner/context, packet coverage, classification and release claims at the SQL boundary', async () => {
  const f = await fixture();
  await f.collect();
  const source = (await f.rows())[0] as Record<string, string | null>;
  for (const kind of [
    'owner',
    'context',
    'missing',
    'signature',
    'classification',
    'release',
  ]) {
    const row: Record<string, string | null> = {
        ...source,
        id: crypto.randomUUID(),
      },
      observation = JSON.parse(row.observation!);
    if (kind === 'owner') row.owner_id = 'bob';
    if (kind === 'context') row.context_sha256 = '0'.repeat(64);
    if (kind === 'missing') observation.receipt.packets.pop();
    if (kind === 'signature')
      observation.receipt.packets[0].signature = 'wrong';
    if (kind === 'classification') {
      row.observed_state = 'complete';
      observation.state = 'complete';
    }
    if (kind === 'release')
      observation.receipt.reservationsMustRemainHeld = false;
    row.observation = JSON.stringify(observation);
    await expect(rawInsert(f.client, row)).rejects.toThrow();
  }
  expect(await f.rows()).toHaveLength(1);
  await rawInsert(f.client, {
    ...source,
    id: crypto.randomUUID(),
    sha256: '0'.repeat(64),
  });
  await expect(
    listOwnedPumpGroupObservations(f.db, 'alice', f.saved.review.id),
  ).rejects.toThrow('observation differs');
}, 60000);
it('pages immutable history by exact owner/review and stable timestamp/id positions', async () => {
  const f = await fixture();
  await f.collect();
  const source = (await f.rows())[0] as Record<string, string | null>;
  for (let i = 0; i < 21; i++)
    await rawInsert(f.client, { ...source, id: crypto.randomUUID() });
  const first = await listOwnedPumpGroupObservations(
    f.db,
    'alice',
    f.saved.review.id,
  );
  expect(first.observations).toHaveLength(20);
  expect(first.nextPosition?.reviewId).toBe(f.saved.review.id);
  const second = await listOwnedPumpGroupObservations(
    f.db,
    'alice',
    f.saved.review.id,
    first.nextPosition,
  );
  expect(second.observations).toHaveLength(2);
  expect(second.nextPosition).toBeNull();
  expect(
    new Set([...first.observations, ...second.observations].map((o) => o.id))
      .size,
  ).toBe(22);
  await expect(
    listOwnedPumpGroupObservations(f.db, 'alice', f.saved.review.id, {
      ...first.nextPosition!,
      reviewId: 'other',
    }),
  ).rejects.toThrow('history position');
  await expect(
    listOwnedPumpGroupObservations(f.db, 'alice', f.saved.review.id, {
      ...first.nextPosition!,
      createdAt: '2026-99-99T00:00:00.000Z',
    }),
  ).rejects.toThrow('history position');
  await expect(
    listOwnedPumpGroupObservations(
      f.db,
      'bob',
      f.saved.review.id,
      first.nextPosition,
    ),
  ).rejects.toThrow('not found');
}, 60000);
it('never writes observation history on provider failure or mid-read cancellation', async () => {
  const f = await fixture();
  await expect(
    f.collect(async () => {
      throw new Error('private provider response');
    }),
  ).rejects.toThrow('read unavailable');
  const control = new AbortController();
  await expect(
    f.collect(
      async (method, params, signal) => {
        const value = await f.rpc(method, params, signal);
        if (method === 'getEpochInfo') control.abort();
        return value;
      },
      'alice',
      control.signal,
    ),
  ).rejects.toThrow();
  expect(await f.rows()).toHaveLength(0);
}, 60000);
