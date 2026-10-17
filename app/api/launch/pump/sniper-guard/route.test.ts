import bs58 from 'bs58';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { pumpCreateAddresses } from '@/lib/pump-launch-message';
import { PUMP_NATIVE_QUOTE } from '@/lib/pump-launch-config';

const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const sig = (n: number) => bs58.encode(new Uint8Array(64).fill(n));
const REVIEW = '6f1c2e8a-1d2b-4c3d-9e4f-5a6b7c8d9e0f',
  mint = key(50),
  dev = key(1),
  holder = key(2),
  sniper = key(9);
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  calls: [] as string[],
  curve: '',
  buys: [] as { n: number; signer: string; lamports: number }[],
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/solana-rpc', () => ({
  getSolanaIndexerRpcEndpoint: () => 'https://rpc.test/',
}));
vi.mock('@/lib/pump-launch-group-review-service', () => ({
  readPumpLaunchGroupReview: async (
    _db: unknown,
    owner: string,
    id: string,
  ) => {
    if (owner !== 'alice' || id !== REVIEW) {
      const { PumpPreflightError } = await import('@/lib/owned-pump-preflight');
      throw new PumpPreflightError(
        'Owned complete-group review not found.',
        404,
      );
    }
    return {
      state: 'signed',
      review: {
        projectId: 'project-1',
        input: {
          create: {
            name: 'T',
            symbol: 'T',
            uri: 'https://x.test/m.json',
            payer: dev,
            mint,
            quoteMint: PUMP_NATIVE_QUOTE,
            blockhash: key(60),
            lastValidBlockHeight: '1',
            global: {
              address: key(61),
              owner: key(62),
              executable: false,
              data: '',
              slot: 1,
            },
          },
          holders: [{ address: holder, kind: 'none' }],
        },
      },
    };
  },
}));
vi.mock('@/lib/wallet-balances', () => ({
  balanceRpc: async (_endpoint: string, method: string, params: unknown[]) => {
    mocks.calls.push(method);
    if (method === 'getSignaturesForAddress') {
      const until = (params[1] as { until?: string }).until;
      const newest = [...mocks.buys]
        .reverse()
        .map((b) => ({ signature: sig(b.n), slot: b.n, err: null }));
      const stop = newest.findIndex((r) => r.signature === until);
      return stop >= 0 ? newest.slice(0, stop) : newest;
    }
    if (method === 'getTransaction') {
      const b = mocks.buys.find((row) => sig(row.n) === params[0])!;
      return {
        slot: b.n,
        blockTime: null,
        meta: {
          err: null,
          preBalances: [5e9, 0],
          postBalances: [4e9, b.lamports],
        },
        transaction: {
          signatures: [sig(b.n)],
          message: {
            accountKeys: [
              { pubkey: b.signer, signer: true },
              { pubkey: mocks.curve, signer: false },
            ],
          },
        },
      };
    }
    if (method === 'getMultipleAccounts') return { value: [null] };
    throw new Error('unexpected ' + method);
  },
}));
import { GET, POST } from './route';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (response: Response): Promise<any> => response.json();

const origin = 'https://bundle.test';
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(
    'CREATE TABLE pump_launch_reviews(id TEXT PRIMARY KEY,owner_id TEXT,state TEXT);CREATE TABLE wallet_ownership_proofs(owner_id TEXT,chain TEXT,address TEXT);CREATE TABLE pump_organic_sequences(id TEXT PRIMARY KEY,owner_id TEXT,launch_review_id TEXT,state TEXT,created_at TEXT);CREATE TABLE imported_token_project_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER);',
  );
  sqlite
    .prepare('INSERT INTO pump_launch_reviews VALUES(?,?,?)')
    .run(REVIEW, 'alice', 'signed');
  for (const file of ['0095_sniper_guards', '0099_sniper_nuke_sells'])
    for (const part of readFileSync(`drizzle/${file}.sql`, 'utf8').split(
      '--> statement-breakpoint',
    ))
      sqlite.exec(part);
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first() {
          return sqlite.prepare(sql).get(...(values as never[])) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...(values as never[])) };
        },
        async run() {
          const r = sqlite.prepare(sql).run(...(values as never[]));
          return { meta: { changes: Number(r.changes) } };
        },
      };
      return statement;
    },
  };
  return { sqlite, db: db as unknown as D1Database };
}
let sqlite: DatabaseSync;
beforeEach(async () => {
  const ctx = database();
  sqlite = ctx.sqlite;
  mocks.db = ctx.db;
  mocks.user = { userId: 'alice' };
  mocks.calls = [];
  mocks.buys = [];
  mocks.curve = String((await pumpCreateAddresses(mint)).bondingCurve);
});
const clearGate = () => sqlite.exec('DELETE FROM imported_token_project_gates');
const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request(origin + '/api/launch/pump/sniper-guard', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
const settings = {
  format: 'sniper-guard-settings-v1',
  thresholdRaw: '1000',
  response: { kind: 'nuke', scope: 'all' },
  end: { kind: 'timed', seconds: 60 },
  whitelist: [],
};

it('requires sign-in, same origin and an exact request shape', async () => {
  mocks.user = null;
  expect((await post({})).status).toBe(401);
  mocks.user = { userId: 'alice' };
  expect(
    (
      await post(
        { action: 'arm', reviewId: REVIEW, revision: 1 },
        { origin: 'https://evil.test' },
      )
    ).status,
  ).toBe(403);
  expect(
    (await post({ action: 'arm', reviewId: REVIEW, revision: 1, extra: 1 }))
      .status,
  ).toBe(400);
  expect(
    (await post({ action: 'send', reviewId: REVIEW, revision: 1 })).status,
  ).toBe(400);
});

it('reads the launch context derived from the saved review', async () => {
  const response = await GET(
    new Request(origin + '/api/launch/pump/sniper-guard?reviewId=' + REVIEW),
  );
  const body = await read(response);
  expect(body.guard).toBeNull();
  expect(body.launch).toMatchObject({
    mint,
    developer: dev,
    holders: [holder],
    bondingCurve: mocks.curve,
    quoteDecimals: 9,
  });
  mocks.user = { userId: 'mallory' };
  expect(
    (
      await GET(
        new Request(
          origin + '/api/launch/pump/sniper-guard?reviewId=' + REVIEW,
        ),
      )
    ).status,
  ).toBe(404);
});

it('reports invalid settings as a 400 with the reason', async () => {
  const response = await post({
    action: 'save',
    reviewId: REVIEW,
    revision: null,
    settings: { ...settings, thresholdRaw: '0' },
  });
  expect(response.status).toBe(400);
  expect((await read(response)).error).toContain('greater than zero');
});

it('saves, arms and triggers using only read-only RPC methods', async () => {
  const saved = await read(
    await post({ action: 'save', reviewId: REVIEW, revision: null, settings }),
  );
  expect(saved.state).toBe('planned');
  expect(
    (await post({ action: 'arm', reviewId: REVIEW, revision: 1 })).status,
  ).toBe(429);
  clearGate();
  const armed = await read(
    await post({ action: 'arm', reviewId: REVIEW, revision: 1 }),
  );
  expect(armed.state).toBe('watching');
  mocks.buys = [
    { n: 1, signer: dev, lamports: 9000 },
    { n: 2, signer: sniper, lamports: 1001 },
  ];
  clearGate();
  const observed = await read(
    await post({ action: 'observe', reviewId: REVIEW, revision: 2 }),
  );
  expect(observed.state).toBe('triggered');
  expect(observed.automaticExecution).toBe(false);
  expect(observed.observation.evaluation.actions.sellWallets).toEqual([
    dev,
    holder,
  ]);
  expect(new Set(mocks.calls)).toEqual(
    new Set([
      'getSignaturesForAddress',
      'getTransaction',
      'getMultipleAccounts',
    ]),
  );
});

it('rejects unknown Nuke actions and Nuke prepare before a trigger', async () => {
  for (const action of ['nuke-submit', 'send'])
    expect(
      (await post({ action, batchId: REVIEW, reviewId: REVIEW })).status,
    ).toBe(400);
  expect(
    (await post({ action: 'nuke-register', reviewId: REVIEW, consent: {} }))
      .status,
  ).toBe(400);
  clearGate();
  const early = await post({ action: 'nuke-prepare', reviewId: REVIEW });
  expect(early.ok).toBe(false);
  expect((await read(early)).error).toBeTruthy();
});
