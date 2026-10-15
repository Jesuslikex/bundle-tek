import {
  parsePumpGroupView,
  parsePumpGroupPage,
  parsePumpGroupObservation,
} from '@/lib/pump-launch-group-client';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Client } from '@libsql/client';
import { pumpOwnedGroupFixture } from '@/test/pump-owned-group-fixture';
import { signSyntheticPumpGroup } from '@/test/pump-group-synthetic-signatures';
import { preflightOwnedPumpCreate } from '@/lib/owned-pump-preflight';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import type { PumpLaunchRpc } from '@/lib/pump-launch-simulation';
import type { readPumpLaunchGroupReview } from '@/lib/pump-launch-group-review-service';
const context = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  rpc: null as PumpLaunchRpc | null,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => context.user,
}));
vi.mock('@/db', () => ({ getD1: () => context.db }));
vi.mock('@/lib/solana-rpc', async (original) => ({
  ...(await original<typeof import('@/lib/solana-rpc')>()),
  getSolanaIndexerRpcEndpoint: () => 'https://controlled-fixture.example',
}));
vi.mock('@/lib/wallet-balances', async (original) => ({
  ...(await original<typeof import('@/lib/wallet-balances')>()),
  balanceRpc: (
    _endpoint: string,
    method: string,
    params: unknown[],
    signal: AbortSignal,
  ) => context.rpc!(method, params, signal),
}));
vi.mock('@/lib/owned-pump-preflight', async (original) => ({
  ...(await original<typeof import('@/lib/owned-pump-preflight')>()),
  preflightOwnedPumpCreate: vi.fn(),
}));
import { GET, POST } from './route';
const clients: Client[] = [];
const mocked = vi.mocked(preflightOwnedPumpCreate);
afterEach(() => {
  mocked.mockReset();
  for (const c of clients.splice(0)) c.close();
});
it('runs HTTP to owned SQL, complete preparation/approval/signature registration and immutable partial observation history without a send', async () => {
  const f = await pumpOwnedGroupFixture(mocked, clients);
  context.user = { userId: 'alice' };
  context.db = f.db;
  context.rpc = f.rpc;
  await f.client.execute(
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT,scope TEXT,intent_id TEXT,state TEXT,PRIMARY KEY(owner_id,wallet_address))',
  );
  await f.client.execute(
    'CREATE TABLE imported_token_project_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
  );
  for (const file of [
    '0079_real_justice',
    '0081_pump_holder_reservations',
    '0082_pump_group_reviews',
    '0083_pump_group_approvals',
    '0084_pump_group_signatures',
    '0085_pump_group_observations',
    '0086_pump_group_terminal_recovery',
  ])
    for (const sql of readFileSync('drizzle/' + file + '.sql', 'utf8').split(
      '--> statement-breakpoint',
    ))
      if (sql.trim()) await f.client.execute(sql);
  const origin = f.terms.origin,
    url = origin + '/api/launch/pump/groups';
  const send = (body: unknown) =>
    POST(
      new Request(url, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  const { origin: _origin, ...terms } = f.terms;
  const prepared = await send({ action: 'prepare', ...terms });
  expect(prepared.status, await prepared.clone().text()).toBe(200);
  const saved = (await prepared.json()) as Awaited<
    ReturnType<typeof readPumpLaunchGroupReview>
  >;
  expect((await parsePumpGroupView(saved, terms.projectId)).review).toEqual(
    saved.review,
  );
  expect(saved.review.input.holders).toHaveLength(18);
  expect(saved.review.packets.length).toBeGreaterThan(1);
  expect(saved).toMatchObject({
    state: 'review',
    signingAllowed: false,
    executionAllowed: false,
    completeLaunch: false,
  });
  expect(f.calls.some((c) => c.method === 'simulateBundle')).toBe(true);
  const id = saved.review.id,
    consent = {
      approved: true,
      reviewId: id,
      manifestSha256: saved.review.manifestSha256,
      contextSha256: saved.review.contextSha256,
      simulationSha256: saved.review.simulationSha256,
      approvedScope: 'complete-create-developer-holder-packet-group',
      acknowledgeSimulationLimits: true,
    };
  const approved = await send({ action: 'approve', id, consent });
  expect(approved.status, await approved.clone().text()).toBe(200);
  const transactions = await signSyntheticPumpGroup(saved.review.packets, [
    f.f.f.payerSigner,
    f.f.f.mintSigner,
    ...f.holderSigners,
  ]);
  const registered = await send({
    action: 'register',
    id,
    consent,
    transactions,
  });
  expect(registered.status, await registered.clone().text()).toBe(200);
  const signed = (await registered.json()) as Awaited<
    ReturnType<typeof readPumpLaunchGroupReview>
  >;
  const signedView = await parsePumpGroupView(signed, terms.projectId);
  expect(signedView.signedEvidence).toEqual(signed.signedEvidence);
  expect(signed.state).toBe('signed');
  expect(signed.signedEvidence!.packets.map((p) => p.transaction)).toEqual(
    transactions,
  );
  expect(
    (await send({ action: 'register', id, consent, transactions })).status,
  ).toBe(200);
  const observationCalls: string[] = [];
  context.rpc = async (method, params) => {
    observationCalls.push(method);
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getTransaction') {
      const i = signed.signedEvidence!.packets.findIndex(
        (p) => p.signature === params[0],
      );
      return i === 0
        ? {
            slot: '200',
            transaction: [transactions[0], 'base64'],
            meta: { err: null, fee: '5000' },
          }
        : null;
    }
    if (method === 'getEpochInfo')
      return {
        blockHeight: saved.review.input.create.lastValidBlockHeight,
        absoluteSlot: '2000',
      };
    throw new Error('Unexpected observation method');
  };
  const observed = await send({ action: 'observe', id });
  expect(observed.status, await observed.clone().text()).toBe(200);
  expect(
    (await parsePumpGroupObservation(await observed.clone().json(), signedView))
      .state,
  ).toBe('partial');
  expect(await observed.json()).toMatchObject({
    state: 'partial',
    sourceState: 'signed',
    receipt: {
      networkFeeUnresolved: true,
      knownNetworkFeeRaw: '5000',
      reservationsMustRemainHeld: true,
      completeLaunch: false,
    },
  });
  const history = await GET(new Request(url + '?id=' + id + '&observations=1'));
  expect(history.status).toBe(200);
  expect(await history.json()).toMatchObject({
    observations: [{ state: 'partial' }],
    nextCursor: null,
  });
  expect(
    (await GET(new Request(url + '?projectId=' + terms.projectId))).status,
  ).toBe(200);
  const groupPage = await GET(
    new Request(url + '?projectId=' + terms.projectId + '&page=1'),
  );
  expect(
    parsePumpGroupPage(await groupPage.json(), terms.projectId).rows.map(
      (row) => row.id,
    ),
  ).toEqual([id]);
  context.user = { userId: 'bob' };
  expect((await GET(new Request(url + '?id=' + id))).status).toBe(404);
  expect(
    (await GET(new Request(url + '?id=' + id + '&observations=1'))).status,
  ).toBe(404);
  expect((await send({ action: 'observe', id })).status).toBe(404);
  context.user = { userId: 'alice' };
  expect((await send({ action: 'cancel', id })).status).toBe(409);
  expect(
    (await send({ action: 'submit', id, consent, submitApproved: true }))
      .status,
  ).toBe(400);
  expect(
    (await f.client.execute('SELECT state,receipt FROM pump_launch_reviews'))
      .rows[0],
  ).toMatchObject({ state: 'signed', receipt: null });
  await expect(
    f.client.execute({
      sql: 'INSERT INTO solana_execution_reservations VALUES(?,?,?,?,?)',
      args: ['alice', f.input.holders[0].address, 'warmup', 'busy', 'approved'],
    }),
  ).rejects.toThrow('reserved');
  expect(
    [...f.calls.map((c) => c.method), ...observationCalls].some(
      (method) =>
        method.startsWith('send') || method.includes('signTransaction'),
    ),
  ).toBe(false);
  context.rpc = async (method, params) => {
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getTransaction') {
      const i = signed.signedEvidence!.packets.findIndex(
        (packet) => packet.signature === params[0],
      );
      return {
        slot: String(210 + i),
        transaction: [transactions[i], 'base64'],
        meta: { err: { InstructionError: [0, 'Custom'] }, fee: '5000' },
      };
    }
    throw new Error('Unexpected terminal method');
  };
  const terminal = await send({ action: 'recover', id });
  expect(terminal.status, await terminal.clone().text()).toBe(200);
  const terminalValue = (await terminal.json()) as {
    group: unknown;
    released: boolean;
  };
  const terminalView = await parsePumpGroupView(
    terminalValue.group,
    terms.projectId,
  );
  expect(terminalValue.released).toBe(true);
  expect(terminalView.state).toBe('failed');
  expect(terminalView.receipt?.kind).toBe('all-packets-failed');
  await f.client.execute({
    sql: 'INSERT INTO solana_execution_reservations VALUES(?,?,?,?,?)',
    args: [
      'alice',
      f.input.holders[0].address,
      'warmup',
      'released',
      'approved',
    ],
  });
}, 120000);
