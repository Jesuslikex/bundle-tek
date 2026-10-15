import { recoverOwnedPumpLaunchGroup } from './pump-launch-group-terminal-service';
import { pumpGroupTerminalCandidate } from './pump-launch-group-terminal';
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
import { collectOwnedPumpGroupObservation } from './pump-launch-group-observation-service';
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
async function fixture(
  installed = true,
  approved = true,
  registered = false,
  terminalInstalled = true,
) {
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
    ...(terminalInstalled ? ['0086_pump_group_terminal_recovery'] : []),
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
const control = () => new AbortController().signal;
const recover = (
  f: Awaited<ReturnType<typeof fixture>>,
  rpc = f.rpc,
  owner = 'alice',
) =>
  recoverOwnedPumpLaunchGroup(f.db, owner, f.saved.review.id, control(), rpc);
const reservation = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.client.execute({
    sql: 'INSERT INTO solana_execution_reservations VALUES(?,?,?,?,?)',
    args: ['alice', f.input.holders[0].address, 'warmup', 'test', 'approved'],
  });
it.each([false, true])(
  'releases an expired never-observed group with signed history retained: %s',
  async (registered) => {
    const f = await fixture(true, true, registered);
    await expect(reservation(f)).rejects.toThrow('reserved');
    f.state.height = (f.last + 33n).toString();
    const result = await recover(f);
    expect(result.released).toBe(true);
    expect(result.group.state).toBe('cancelled');
    expect(result.group.receipt).toMatchObject({
      kind: 'expired-unobserved',
      reservationsReleased: true,
      networkFeeUnresolved: true,
      economicSettlementVerified: false,
    });
    expect(result.group.signedEvidence).toEqual(
      registered ? f.signed!.signedEvidence : null,
    );
    await expect(reservation(f)).resolves.toBeDefined();
    const reads = f.calls.length;
    expect((await recover(f)).observation).toBeNull();
    expect(f.calls).toHaveLength(reads);
    await expect(
      f.client.execute('DELETE FROM pump_group_terminal_recoveries'),
    ).rejects.toThrow('retained');
    await expect(
      f.client.execute(
        "UPDATE pump_group_terminal_recoveries SET receipt='{}'",
      ),
    ).rejects.toThrow('Immutable');
  },
);
it('closes all finalized failures with known fees but does not claim economic settlement', async () => {
  const f = await fixture(true, true, true);
  const slot =
    Math.max(
      f.saved.review.simulation.bankSlot,
      f.saved.review.simulation.maximumSlot,
      f.saved.review.simulation.sourceRecheckSlot,
    ) + 10;
  f.state.packets = f.signed!.signedEvidence!.packets.map((p, i) => ({
    slot: String(slot + i),
    transaction: [p.transaction, 'base64'],
    meta: { err: { InstructionError: [0, 'Custom'] }, fee: '5000' },
  }));
  const result = await recover(f);
  expect(result.group.state).toBe('failed');
  expect(result.released).toBe(true);
  expect(result.group.receipt).toMatchObject({
    kind: 'all-packets-failed',
    knownNetworkFeeRaw: String(f.state.packets.length * 5000),
    networkFeeUnresolved: false,
    economicSettlementVerified: false,
  });
  await expect(reservation(f)).resolves.toBeDefined();
});
it.each(['pending', 'partial', 'unknown', 'complete'] as const)(
  'keeps reservations for %s observations',
  async (kind) => {
    const f = await fixture(true, true, true);
    const slot =
      Math.max(
        f.saved.review.simulation.bankSlot,
        f.saved.review.simulation.maximumSlot,
        f.saved.review.simulation.sourceRecheckSlot,
      ) + 10;
    if (kind === 'partial' || kind === 'complete')
      f.state.packets = f.signed!.signedEvidence!.packets.map((p, i) =>
        kind === 'partial' && i > 0
          ? null
          : {
              slot: String(slot + i),
              transaction: [p.transaction, 'base64'],
              meta: { err: null, fee: '5000' },
            },
      );
    if (kind === 'unknown') f.state.height = (f.last + 33n).toString();
    const rpc: PumpLaunchRpc = async (method, params, signal) =>
      kind === 'unknown' && method === 'getAccountInfo'
        ? {
            context: { slot: (f.last + 2001n).toString() },
            value: {
              owner: '11111111111111111111111111111111',
              executable: false,
              lamports: '1',
              data: ['', 'base64'],
            },
          }
        : f.rpc(method, params, signal);
    const result = await recover(f, rpc);
    expect(result.observation?.state).toBe(kind);
    expect(result.released).toBe(false);
    expect(result.group.state).toBe('signed');
    expect(
      (
        await f.client.execute(
          'SELECT count(*) AS n FROM pump_group_terminal_recoveries',
        )
      ).rows[0].n,
    ).toBe(0);
    await expect(reservation(f)).rejects.toThrow('reserved');
  },
);
it('refuses missing migration and foreign owner before contacting RPC', async () => {
  const f = await fixture(true, true, false, false);
  await expect(recover(f)).rejects.toThrow('migration');
  expect(f.calls).toHaveLength(0);
  const g = await fixture();
  await expect(recover(g, g.rpc, 'bob')).rejects.toThrow('not found');
  expect(g.calls).toHaveLength(0);
});
it('refuses direct state changes and injected recovery events without the exact fresh stored observation', async () => {
  const f = await fixture(true, true, true);
  await expect(
    f.client.execute(
      "UPDATE pump_launch_reviews SET state='cancelled',receipt='{}'",
    ),
  ).rejects.toThrow();
  await expect(
    f.client.execute({
      sql: 'INSERT INTO pump_group_terminal_recoveries VALUES(?,?,?,?,?)',
      args: [
        f.saved.review.id,
        'alice',
        crypto.randomUUID(),
        '{}',
        new Date().toISOString(),
      ],
    }),
  ).rejects.toThrow();
  expect(
    (await f.client.execute('SELECT state FROM pump_launch_reviews')).rows[0]
      .state,
  ).toBe('signed');
});
it('rejects stale proof and rolls back the terminal event if applying its parent transition fails', async () => {
  const f = await fixture();
  f.state.height = (f.last + 33n).toString();
  const observed = await f.collect();
  await expect(
    pumpGroupTerminalCandidate(
      f.saved.review,
      observed,
      Date.parse(observed.createdAt) + 5001,
    ),
  ).rejects.toThrow('Fresh');
  await f.client.execute(
    "CREATE TRIGGER test_terminal_abort BEFORE UPDATE ON pump_launch_reviews WHEN NEW.state='cancelled' BEGIN SELECT RAISE(ABORT,'controlled rollback'); END",
  );
  await expect(recover(f)).rejects.toThrow('before release');
  expect(
    (
      await f.client.execute(
        'SELECT count(*) AS n FROM pump_group_terminal_recoveries',
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (await f.client.execute('SELECT state FROM pump_launch_reviews')).rows[0]
      .state,
  ).toBe('approved');
});
