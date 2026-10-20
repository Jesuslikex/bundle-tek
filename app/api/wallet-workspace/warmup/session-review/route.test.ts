import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
  it,
  vi,
} from 'vitest';
import { Miniflare } from 'miniflare';
import bs58 from 'bs58';
import { buildWarmupPlan } from '@/lib/wallet-warmup';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { POST } from './route';
let mf: Miniflare, db: D1Database;
let reads: string[] = [];
const wallet = bs58.encode(new Uint8Array(32).fill(1)),
  mint = bs58.encode(new Uint8Array(32).fill(2)),
  now = Date.parse('2026-10-20T12:00:00Z');
const document = {
  name: 'Synthetic',
  chain: 'Solana',
  addresses: [wallet],
  walletRevisions: [{ address: wallet, revision: 2 }],
  tokens: [mint],
  amount: '0.001',
  feeReserve: '0.01',
  cycles: 1,
  intervalSeconds: 10,
  startAt: new Date(now).toISOString(),
  totalBudget: '0.011',
};
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'warmup-session-review',
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
          env: { DB: { type: 'd1', id: 'warmup-session-review' } },
        },
      },
    ],
  });
  db = (await mf.getD1Database(
    'DB',
    'warmup-session-review',
  )) as unknown as D1Database;
  for (const sql of [
    'CREATE TABLE wallet_warmup_plans(owner_id TEXT,id TEXT,revision INTEGER,archived INTEGER,updated_at TEXT,document TEXT)',
    'CREATE TABLE warmup_buy_receipts(owner_id TEXT,plan_id TEXT,id TEXT,plan_revision INTEGER,wallet_revision INTEGER,cycle INTEGER,wallet_address TEXT,signature TEXT,remaining_raw TEXT,document TEXT)',
    'CREATE TABLE warmup_sell_receipts(owner_id TEXT,plan_id TEXT,id TEXT,buy_receipt_id TEXT,consumed_raw TEXT,signature TEXT,document TEXT)',
    'CREATE TABLE solana_swap_reservations(owner_id TEXT,intent_id TEXT,wallet_address TEXT,state TEXT)',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
  ])
    await db.prepare(sql).run();
});
afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  for (const table of [
    'wallet_warmup_plans',
    'warmup_buy_receipts',
    'warmup_sell_receipts',
    'solana_swap_reservations',
    'workspace_wallets',
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
  expect(buildWarmupPlan(document, now).totalBudget).toBe(document.totalBudget);
  await db
    .prepare('INSERT INTO wallet_warmup_plans VALUES(?,?,?,?,?,?)')
    .bind(
      'one',
      'qa',
      1,
      0,
      new Date(now).toISOString(),
      JSON.stringify(document),
    )
    .run();
  await db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?)')
    .bind('one', 'Solana', wallet, 2, 0)
    .run();
  reads = [];
  mocks.user = { userId: 'one' };
  mocks.db = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          reads.push(sql);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
});
afterEach(() => vi.restoreAllMocks());
function read(
  body: unknown = { id: 'qa', revision: 1 },
  headers: Record<string, string> = {
    origin: 'http://localhost',
    'content-type': 'application/json',
  },
  signal?: AbortSignal,
) {
  return POST(
    new Request('http://localhost/api/wallet-workspace/warmup/session-review', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal,
    }),
  );
}
async function addBuy(remaining = '10') {
  const evidence = {
    signatureVerified: true,
    signature: bs58.encode(new Uint8Array(64).fill(3)),
    wallet,
    mint,
    acquiredRaw: '10',
    decimals: 6,
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    slot: 100,
    preparationSha256: 'a'.repeat(64),
    nativeSettlementRaw: '-1000000',
    networkFeeLamports: '5000',
    rentChangeRaw: '0',
    commitment: 'finalized',
    network: 'mainnet',
  };
  await db
    .prepare('INSERT INTO warmup_buy_receipts VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind(
      'one',
      'qa',
      'lot',
      1,
      2,
      1,
      wallet,
      evidence.signature,
      remaining,
      JSON.stringify(evidence),
    )
    .run();
}
it('requires authentication before any stored read', async () => {
  mocks.user = null;
  expect((await read()).status).toBe(401);
  expect(reads).toEqual([]);
});
it.each([
  [
    { origin: 'https://other.example', 'content-type': 'application/json' },
    403,
  ],
  [{ 'content-type': 'application/json' }, 403],
  [{ origin: 'http://localhost', 'content-type': 'text/plain' }, 415],
  [{ origin: 'http://localhost', 'content-type': 'application/jsonp' }, 415],
] as const)(
  'requires exact origin and JSON media type (%j)',
  async (headers, status) => {
    expect((await read(undefined, headers)).status).toBe(status);
    expect(reads).toEqual([]);
  },
);
it.each(
  [
    null,
    [],
    { id: 'qa', revision: 0 },
    { id: 'qa', revision: 1, progress: { completedSteps: 1 } },
    { id: 'qa', revision: 1, maximumNativeSpendLamports: '999999999' },
    { id: 'qa', revision: 1, includeEarlier: true },
  ].map((body) => ({ body })),
)(
  'rejects malformed or client-supplied evidence before SQL: $body',
  async ({ body }) => {
    expect((await read(body)).status).toBe(400);
    expect(reads).toEqual([]);
  },
);
it('bounds streamed UTF-8 bytes and rejects malformed JSON without SQL', async () => {
  expect(
    (await read('{"id":"' + 'ü'.repeat(1100) + '","revision":1}')).status,
  ).toBe(413);
  expect((await read('{broken')).status).toBe(400);
  expect(reads).toEqual([]);
});
it('rebuilds an owned finite review with false authority flags using only one SELECT batch', async () => {
  const response = await read(),
    result = (await response.json()) as {
      review: {
        actions: unknown[];
        executionAllowed: boolean;
        signingAllowed: boolean;
        automaticExecutionAllowed: boolean;
        totalMaximumNativeSpendLamports: string;
      };
      reviewExpiresAt: string;
    };
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(result.review.actions).toHaveLength(2);
  expect(result.review).toMatchObject({
    executionAllowed: false,
    signingAllowed: false,
    automaticExecutionAllowed: false,
    totalMaximumNativeSpendLamports: '11000000',
  });
  expect(result.reviewExpiresAt).toBe(new Date(now + 60000).toISOString());
  expect(reads).toHaveLength(5);
  expect(reads.every((sql) => sql.startsWith('SELECT'))).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(
    /privateKey|signedTransaction|"transaction"/,
  );
});
it('isolates owners and rejects stale plan revisions', async () => {
  mocks.user = { userId: 'two' };
  expect((await read()).status).toBe(404);
  mocks.user = { userId: 'one' };
  expect((await read({ id: 'qa', revision: 2 })).status).toBe(409);
});
it.each([
  'wallet-revision',
  'archived-wallet',
  'archived-plan',
  'missing-wallet',
] as const)('refuses unavailable active ownership: %s', async (kind) => {
  if (kind === 'wallet-revision')
    await db.prepare('UPDATE workspace_wallets SET revision=3').run();
  if (kind === 'archived-wallet')
    await db.prepare('UPDATE workspace_wallets SET archived=1').run();
  if (kind === 'archived-plan')
    await db.prepare('UPDATE wallet_warmup_plans SET archived=1').run();
  if (kind === 'missing-wallet')
    await db.prepare('DELETE FROM workspace_wallets').run();
  expect((await read()).status).toBe(409);
});
it('requires recovery of another plan’s active approval on the same wallet', async () => {
  await db
    .prepare('INSERT INTO solana_swap_reservations VALUES(?,?,?,?)')
    .bind('one', 'other-plan-approval', wallet, 'submitted')
    .run();
  const response = await read();
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: expect.stringContaining('Recover every active approval'),
  });
});
it('uses current retained buy units without replacing the buy or resetting recorded fees', async () => {
  await addBuy();
  const response = await read();
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toMatchObject({
    review: {
      actions: [
        {
          side: 'Sell',
          source: {
            kind: 'saved-buy',
            buyReceiptId: 'lot',
            remainingRaw: '10',
          },
        },
      ],
      wallets: [
        {
          recordedBuySpendLamports: '1000000',
          recordedNetworkFeesLamports: '5000',
          remainingFeeReserveLamports: '9995000',
          maximumNativeSpendLamports: '9995000',
        },
      ],
    },
  });
});
it('sanitizes damaged receipt evidence instead of returning a partial review', async () => {
  await addBuy();
  await db
    .prepare(
      "UPDATE warmup_buy_receipts SET document=json_set(document,'$.networkFeeLamports','SECRET_BAD_ECONOMICS')",
    )
    .run();
  const response = await read();
  expect(response.status).toBe(503);
  const result = await response.json();
  expect(result).not.toHaveProperty('review');
  expect(JSON.stringify(result)).not.toContain('SECRET_BAD_ECONOMICS');
});
it('does not read storage for a cancelled request', async () => {
  const controller = new AbortController();
  controller.abort();
  expect((await read(undefined, undefined, controller.signal)).status).toBe(
    408,
  );
  expect(reads).toEqual([]);
});
