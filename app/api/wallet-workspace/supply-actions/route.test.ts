import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import {
  chain,
  MINT,
  supplySession,
  WALLET,
} from '../../../../test/token-supply-fixture';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  fetcher: null as unknown as typeof fetch,
  rpc: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/token-supply-action-server', async (original) => {
  const actual =
    await original<typeof import('@/lib/token-supply-action-server')>();
  return {
    ...actual,
    prepareSupplyAction: (
      input: Parameters<typeof actual.prepareSupplyAction>[0],
      signal: AbortSignal,
    ) => actual.prepareSupplyAction(input, signal, mocks.fetcher),
    recheckSupplyAction: (
      review: Parameters<typeof actual.recheckSupplyAction>[0],
      signal: AbortSignal,
    ) => actual.recheckSupplyAction(review, signal, mocks.fetcher),
  };
});
vi.mock('@/lib/wallet-balances', async (original) => {
  const actual = await original<typeof import('@/lib/wallet-balances')>();
  return {
    ...actual,
    balanceRpc: (...args: Parameters<typeof actual.balanceRpc>) =>
      args[4] !== fetch ? actual.balanceRpc(...args) : mocks.rpc(...args),
  };
});
import { GET, POST } from './route';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import {
  signSupplyAction,
  type TokenSupplyAction,
} from '@/lib/token-supply-action';

let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'supply-action-test',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents: 'export default {fetch(){return new Response("ok")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'supply-action-test-only' } },
        },
      },
    ],
  });
  mocks.db = await mf.getD1Database('DB', 'supply-action-test');
  for (const sql of [
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
    'CREATE TABLE solana_execution_reservations(owner_id TEXT NOT NULL,wallet_address TEXT NOT NULL,scope TEXT NOT NULL,intent_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(owner_id,wallet_address))',
    'CREATE TABLE solana_execution_signatures(owner_id TEXT NOT NULL,signature TEXT NOT NULL,scope TEXT NOT NULL,intent_id TEXT NOT NULL,PRIMARY KEY(owner_id,signature))',
    'CREATE TABLE pump_launch_reviews(id TEXT,owner_id TEXT,payer TEXT,state TEXT)',
  ])
    await mocks.db.prepare(sql).run();
  const migration = await readFile(
    new URL(
      '../../../../drizzle/0096_token_supply_actions.sql',
      import.meta.url,
    ),
    'utf8',
  );
  for (const statement of migration
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(statement).run();
});
afterAll(() => mf.dispose());
let fake: ReturnType<typeof chain>;
beforeEach(async () => {
  mocks.user = { userId: 'alice' };
  for (const table of [
    'workspace_wallets',
    'solana_execution_reservations',
    'pump_launch_reviews',
  ])
    await mocks.db.prepare(`DELETE FROM ${table}`).run();
  await mocks.db
    .prepare("INSERT INTO workspace_wallets VALUES('alice','Solana',?,1,0)")
    .bind(WALLET)
    .run();
  fake = chain('burn');
  mocks.fetcher = fake.fetcher;
  mocks.rpc.mockReset();
});
const post = (body: object) =>
  POST(
    new Request('https://bundle.test/api/wallet-workspace/supply-actions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://bundle.test',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify(body),
    }),
  );
const prepare = (overrides: object = {}) =>
  post({
    action: 'prepare',
    kind: 'burn',
    wallet: WALLET,
    walletRevision: 1,
    mint: MINT,
    percent: '1',
    acknowledgeIrreversible: true,
    ...overrides,
  });

it('runs a burn through prepare, sign, register, submit and recover', async () => {
  const prepared = await prepare();
  expect(prepared.status).toBe(200);
  const { action } = (await prepared.json()) as { action: TokenSupplyAction };
  expect(action.state).toBe('awaiting_signature');
  // A second review for the same wallet is refused while the first is open.
  expect((await prepare()).status).toBe(409);
  const claimed = await post({ action: 'begin_signing', id: action.id });
  expect(
    ((await claimed.json()) as { action: TokenSupplyAction }).action.state,
  ).toBe('signing');
  const signed = await signSupplyAction(
    supplySession,
    action.document,
    () => {},
  );
  const registered = await post({
    action: 'register',
    id: action.id,
    transaction: signed.transaction,
  });
  const reg = (await registered.json()) as { action: TokenSupplyAction };
  expect(reg.action).toMatchObject({
    state: 'signed',
    signature: signed.signature,
  });
  mocks.rpc.mockImplementation(async (_e: string, method: string) => {
    if (method === 'sendTransaction') return signed.signature;
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getTransaction')
      return {
        transaction: [signed.transaction, 'base64'],
        slot: 150,
        blockTime: null,
        meta: {
          err: null,
          fee: 5000,
          preBalances: [1_000_000_000, 0],
          postBalances: [999_995_000, 0],
          preTokenBalances: [
            {
              accountIndex: 1,
              mint: MINT,
              owner: WALLET,
              uiTokenAmount: { amount: '50000000000000' },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 1,
              mint: MINT,
              owner: WALLET,
              uiTokenAmount: { amount: '40000000000000' },
            },
          ],
        },
      };
    throw new Error(method);
  });
  const submitted = await post({
    action: 'submit',
    id: action.id,
    transaction: signed.transaction,
  });
  expect(
    ((await submitted.json()) as { action: TokenSupplyAction }).action.state,
  ).toBe('submitted');
  const recovered = await post({ action: 'recover', id: action.id });
  const done = (await recovered.json()) as { action: TokenSupplyAction };
  expect(done.action.state).toBe('finalized');
  expect(done.action.receipt?.supplyChangeRaw).toBe('-10000000000000');
  const history = await GET(
    new Request(
      'https://bundle.test/api/wallet-workspace/supply-actions?wallet=' +
        WALLET,
    ),
  );
  const listed = (await history.json()) as {
    actions: TokenSupplyAction[];
    active: TokenSupplyAction | null;
  };
  expect(listed.actions.map((a) => a.id)).toContain(action.id);
  expect(listed.active).toBeNull();
});

it('requires the irreversible acknowledgement and an owned current wallet', async () => {
  const unacknowledged = await prepare({ acknowledgeIrreversible: false });
  expect(unacknowledged.status).toBe(400);
  expect(((await unacknowledged.json()) as { error: string }).error).toMatch(
    /cannot be undone/,
  );
  mocks.user = { userId: 'mallory' };
  expect((await prepare()).status).toBe(409);
});

it('blocks wallets reserved elsewhere and other actions while one is open', async () => {
  await mocks.db
    .prepare(
      "INSERT INTO solana_execution_reservations VALUES('alice',?,'withdrawal','w1','awaiting_signature')",
    )
    .bind(WALLET)
    .run();
  expect((await prepare()).status).toBe(409);
  await mocks.db.prepare('DELETE FROM solana_execution_reservations').run();
  const { action } = (await (await prepare()).json()) as {
    action: TokenSupplyAction;
  };
  // A withdrawal or swap reservation for the same wallet is now refused by the database.
  await expect(
    mocks.db
      .prepare(
        "INSERT INTO solana_execution_reservations VALUES('alice',?,'withdrawal','w2','awaiting_signature')",
      )
      .bind(WALLET)
      .run(),
  ).rejects.toThrow(/Wallet already reserved/);
  const cancelled = await post({ action: 'cancel', id: action.id });
  expect(
    ((await cancelled.json()) as { action: TokenSupplyAction }).action.state,
  ).toBe('cancelled');
  await mocks.db
    .prepare(
      "INSERT INTO solana_execution_reservations VALUES('alice',?,'withdrawal','w3','awaiting_signature')",
    )
    .bind(WALLET)
    .run();
});

it('refuses a forged signature at registration', async () => {
  const { action } = (await (await prepare()).json()) as {
    action: TokenSupplyAction;
  };
  await post({ action: 'begin_signing', id: action.id });
  const bytes = Uint8Array.from(atob(action.document.transaction), (c) =>
    c.charCodeAt(0),
  );
  bytes.set(new Uint8Array(64).fill(3), 1);
  const forged = await post({
    action: 'register',
    id: action.id,
    transaction: btoa(String.fromCharCode(...bytes)),
  });
  expect(forged.status).toBeGreaterThanOrEqual(400);
});
