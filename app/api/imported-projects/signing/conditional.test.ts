import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { nativeWarmupFixture } from '../../../../test/warmup-native-fixture';
import { unsignedPreparationSummary } from '@/lib/imported-swap-preparation-history';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  simulate: vi.fn(),
  prepare: vi.fn(),
  balance: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/imported-swap-simulation', async (original) => {
  const actual =
    await original<typeof import('@/lib/imported-swap-simulation')>();
  return {
    ...actual,
    simulateImportedSwap: (
      order: Parameters<typeof actual.simulateImportedSwap>[0],
      signal: AbortSignal,
      fetcher: typeof fetch,
      strict: boolean,
    ) =>
      fetcher && fetcher !== fetch
        ? actual.simulateImportedSwap(order, signal, fetcher, strict)
        : mocks.simulate(order, signal, fetcher, strict),
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
vi.mock('@/lib/warmup-swap-quote', async (original) => {
  const actual = await original<typeof import('@/lib/warmup-swap-quote')>();
  return {
    ...actual,
    prepareSolanaSwap: (...args: unknown[]) => mocks.prepare(...args),
  };
});
vi.mock('@/lib/imported-swap-balance', async (original) => {
  const actual = await original<typeof import('@/lib/imported-swap-balance')>();
  return {
    ...actual,
    observeImportedSwapBalance: (...args: unknown[]) => mocks.balance(...args),
  };
});
import { POST, GET } from './route';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import { conditionalSellTerms } from '@/lib/conditional-sell-order';
import { captureConditionalPreparation } from '@/lib/conditional-preparation-server';
import { requireSelectedConditionalPreparation } from '@/lib/conditional-preparation-selection';
import type { ConditionalSellOrder } from '@/lib/conditional-sell-order';
import { GET as listOrders } from '../conditional-orders/route';
let owner: string;
const orderId = '33333333-3333-4333-8333-333333333333';
let conditional: Awaited<ReturnType<typeof captureConditionalPreparation>>;
let mf: Miniflare;
let f: Awaited<ReturnType<typeof nativeWarmupFixture>>;
const projectId = '11111111-1111-4111-8111-111111111111';
let preparationId: string;
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'conditional-signing-test',
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
          env: { DB: { type: 'd1', id: 'imported-signing-test-only' } },
        },
      },
    ],
  });
  mocks.db = await mf.getD1Database('DB', 'conditional-signing-test');
  await mocks.db
    .prepare(
      'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
    )
    .run();
  await mocks.db
    .prepare(
      'CREATE TABLE wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
    )
    .run();
  await mocks.db
    .prepare(
      'CREATE TABLE imported_market_observations(owner_id TEXT,project_id TEXT,document TEXT)',
    )
    .run();
  for (const name of [
    '0024_imported_token_projects',
    '0041_imported_swap_preparations',
    '0045_warmup_signing_intents',
    '0047_shared_swap_reservations',
    '0048_imported_signing_events',
    '0049_native_withdrawals',
    '0051_imported_swap_failure',
    '0053_imported_lot_links',
    '0054_imported_approved_acquisition',
    '0055_imported_acquisition_baskets',
    '0056_conditional_sell_orders',
    '0057_conditional_level_lifecycle',
    '0058_imported_trade_sessions',
    '0059_imported_trade_session_events',
    '0060_imported_trade_session_timing',
    '0061_imported_trade_session_controls',
    '0062_session_preparation_jobs',
  ]) {
    const sql = await readFile(
      new URL(`../../../../drizzle/${name}.sql`, import.meta.url),
      'utf8',
    );
    for (const statement of sql
      .split('--> statement-breakpoint')
      .filter((s) => s.trim()))
      await mocks.db.prepare(statement).run();
  }
});
afterAll(async () => {
  await mf?.dispose();
});
async function store(fixture: typeof f) {
  await mocks.db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,?,?,1,0,?,?)')
    .bind(
      owner,
      projectId,
      'Solana',
      fixture.mint,
      JSON.stringify({
        token: { chain: 'Solana', address: fixture.mint, decimals: 6 },
      }),
      crypto.randomUUID(),
      new Date().toISOString(),
    )
    .run();
  await mocks.db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,0)')
    .bind(owner, 'Solana', fixture.wallet, 1)
    .run();
  const doc = {
    ...unsignedPreparationSummary(fixture.order, fixture.simulation),
    balance: {
      source: 'fixture.test',
      observedAt: new Date().toISOString(),
      requestedRaw: fixture.order.inAmount,
      amountCovered: true,
    },
  };
  await mocks.db
    .prepare('INSERT INTO imported_swap_preparations VALUES(?,?,?,?,?,?,?,?)')
    .bind(
      preparationId,
      owner,
      projectId,
      1,
      fixture.wallet,
      1,
      JSON.stringify(doc),
      new Date().toISOString(),
    )
    .run();
}
beforeEach(async () => {
  owner = crypto.randomUUID();
  preparationId = crypto.randomUUID();
  mocks.user = { userId: owner };
  f = await nativeWarmupFixture({ side: 'Sell', lookup: true, v2: true });
  await store(f);
  const now = new Date().toISOString();
  const terms = conditionalSellTerms(
    {
      projectId,
      projectRevision: 1,
      wallet: f.wallet,
      walletRevision: 1,
      pair: f.mint,
      kind: 'limit',
      direction: 'at-or-above',
      amount: '0.001',
      targetUsd: '100',
    },
    { chain: 'Solana', address: f.mint, decimals: 6 },
  );
  await mocks.db
    .prepare(
      "INSERT INTO conditional_sell_orders VALUES(?,?,?,?,'draft',1,?,?)",
    )
    .bind(owner, orderId, projectId, JSON.stringify(terms), now, now)
    .run();
  await market(110);
  conditional = await captureConditionalPreparation(
    mocks.db,
    owner,
    { orderId, revision: 1, level: 1 },
    {
      projectId,
      projectRevision: 1,
      wallet: f.wallet,
      walletRevision: 1,
      mint: f.mint,
      decimals: 6,
      side: 'Sell',
      unitsRaw: f.order.inAmount,
    },
  );
  await mocks.db
    .prepare(
      "UPDATE imported_swap_preparations SET document=json_set(document,'$.conditional',json(?)) WHERE owner_id=? AND id=?",
    )
    .bind(JSON.stringify(conditional.selection), owner, preparationId)
    .run();
  mocks.simulate.mockReset().mockResolvedValue(f.simulation);
  mocks.rpc
    .mockReset()
    .mockImplementation(async (_endpoint, method) =>
      method === 'getGenesisHash'
        ? SOLANA_MAINNET_GENESIS
        : method === 'sendTransaction'
          ? f.signed.signature
          : method === 'getTransaction'
            ? f.receipt
            : null,
    );
});
async function market(cap: number, age = 0) {
  const document = JSON.stringify([
    {
      chain: 'Solana',
      address: f.mint,
      projectRevision: 1,
      source: 'api.dexscreener.com',
      executionAllowed: false,
      observedAt: new Date(Date.now() - age).toISOString(),
      pairs: [{ address: f.mint, marketCapUsd: cap }],
    },
  ]);
  await mocks.db
    .prepare('DELETE FROM imported_market_observations WHERE owner_id=?')
    .bind(owner)
    .run();
  await mocks.db
    .prepare('INSERT INTO imported_market_observations VALUES(?,?,?)')
    .bind(owner, projectId, document)
    .run();
}
const post = (body: object) =>
  POST(
    new Request('http://localhost/api/imported-projects/signing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
async function reviewed() {
  const response = await post({
    action: 'review',
    preparationId,
    transaction: f.order.preparation.transaction,
  });
  expect(response.status).toBe(200);
  return (
    (await response.json()) as {
      review: import('@/lib/warmup-signing').WarmupSigningReview;
    }
  ).review;
}
async function count(table: string) {
  return (await mocks.db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id=?`)
    .bind(owner)
    .first<{ n: number }>())!.n;
}
it('reads only the selected owned conditional approval, including archived projects', async () => {
  const review = await reviewed();
  const read = (intentId = review.id, extra = '') =>
    GET(
      new Request(
        `https://bundle.test/api/imported-projects/signing?projectId=${projectId}&intentId=${intentId}${extra}`,
      ),
    );
  const response = await read();
  expect(response.status).toBe(200);
  const page = (await response.json()) as {
    intents: { id: string; document: { conditional: unknown } }[];
    nextCursor: null;
  };
  expect(page.intents.map((row) => row.id)).toEqual([review.id]);
  expect(page.intents[0].document.conditional).toEqual(review.conditional);
  expect(page.nextCursor).toBeNull();
  expect((await read('99999999-9999-4999-8999-999999999999')).status).toBe(404);
  expect((await read('invalid')).status).toBe(400);
  expect((await read(review.id, `&cursor=${review.id}`)).status).toBe(400);
  mocks.user = { userId: 'foreign' };
  expect((await read()).status).toBe(404);
  mocks.user = null;
  expect((await read()).status).toBe(401);
  mocks.user = { userId: owner };
  await mocks.db
    .prepare(
      'UPDATE imported_token_projects SET archived=1,revision=2 WHERE owner_id=?',
    )
    .bind(owner)
    .run();
  expect((await read()).status).toBe(200);
  expect(
    mocks.rpc.mock.calls.some((call) => call[1] === 'sendTransaction'),
  ).toBe(false);
});
async function sign(id: string) {
  expect(
    (await post({ action: 'register', id, transaction: f.signed.transaction }))
      .status,
  ).toBe(200);
}
it('binds actual reviewed packet to the conditional level, separately registers and submits once, then finalizes one fill', async () => {
  const retainedOrders = (await (
    await listOrders(
      new Request(
        `http://localhost/api/imported-projects/conditional-orders?projectId=${projectId}`,
      ),
    )
  ).json()) as { orders: ConditionalSellOrder[] };
  await expect(
    requireSelectedConditionalPreparation(
      conditional.selection,
      { orderId, revision: 1, level: 1 },
      retainedOrders.orders[0],
      {
        projectId,
        projectRevision: 1,
        wallet: f.wallet,
        walletRevision: 1,
        mint: f.mint,
        decimals: 6,
        side: 'Sell',
        unitsRaw: f.order.inAmount,
      },
    ),
  ).resolves.toEqual(conditional.selection);
  const review = await reviewed();
  expect(review.conditional).toEqual(conditional.selection);
  expect(Date.parse(review.expiresAt)).toBe(
    Math.min(
      Date.parse(f.order.expiresAt),
      Date.parse(conditional.selection.expiresAt),
    ),
  );
  expect(await count('conditional_level_reservations')).toBe(1);
  await sign(review.id);
  expect(
    (
      await post({
        action: 'submit',
        id: review.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post({
        action: 'submit',
        id: review.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(409);
  const recovered = await post({ action: 'recover', id: review.id });
  expect(recovered.status).toBe(200);
  expect(((await recovered.json()) as { state: string }).state).toBe(
    'finalized',
  );
  expect(await count('conditional_level_fills')).toBe(1);
  expect(await count('conditional_level_reservations')).toBe(0);
  expect(await count('solana_swap_reservations')).toBe(0);
  expect((await post({ action: 'recover', id: review.id })).status).toBe(200);
  expect(await count('conditional_level_fills')).toBe(1);
  const history = await GET(
    new Request(
      `http://localhost/api/imported-projects/signing?projectId=${projectId}`,
    ),
  );
  expect(
    (
      (await history.json()) as {
        intents: { document: { conditional: unknown } }[];
      }
    ).intents[0].document.conditional,
  ).toEqual(conditional.selection);
  const page = await listOrders(
    new Request(
      `http://localhost/api/imported-projects/conditional-orders?projectId=${projectId}`,
    ),
  );
  expect(
    ((await page.json()) as { levels: unknown[] }).levels[0],
  ).toMatchObject({
    state: 'filled',
    intentId: review.id,
    unitsRaw: '1000',
    signature: f.signed.signature,
  });
});
it('withholds approval when the current observation becomes stale or unmet without reserving anything', async () => {
  await market(99);
  expect(
    (
      await post({
        action: 'review',
        preparationId,
        transaction: f.order.preparation.transaction,
      })
    ).status,
  ).toBe(409);
  await market(110, 31000);
  expect(
    (
      await post({
        action: 'review',
        preparationId,
        transaction: f.order.preparation.transaction,
      })
    ).status,
  ).toBe(409);
  expect(mocks.simulate).not.toHaveBeenCalled();
  expect(await count('conditional_level_reservations')).toBe(0);
  expect(await count('solana_swap_reservations')).toBe(0);
});
it('rechecks market after approval simulation and rejects a replacement without locks', async () => {
  mocks.simulate.mockImplementationOnce(async () => {
    await market(99);
    return f.simulation;
  });
  expect(
    (
      await post({
        action: 'review',
        preparationId,
        transaction: f.order.preparation.transaction,
      })
    ).status,
  ).toBe(409);
  expect(await count('conditional_level_reservations')).toBe(0);
  expect(await count('solana_swap_reservations')).toBe(0);
});
it('keeps a registered signature reserved when submission condition is unmet, then recovers across archival', async () => {
  const review = await reviewed();
  await sign(review.id);
  await market(99);
  expect(
    (
      await post({
        action: 'submit',
        id: review.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(409);
  expect(mocks.rpc.mock.calls.some((c) => c[1] === 'sendTransaction')).toBe(
    false,
  );
  expect(await count('conditional_level_reservations')).toBe(1);
  await mocks.db
    .prepare(
      'UPDATE imported_token_projects SET archived=1,revision=2 WHERE owner_id=?',
    )
    .bind(owner)
    .run();
  await mocks.db
    .prepare(
      'UPDATE workspace_wallets SET archived=1,revision=2 WHERE owner_id=?',
    )
    .bind(owner)
    .run();
  expect((await post({ action: 'recover', id: review.id })).status).toBe(200);
  expect(await count('conditional_level_fills')).toBe(1);
});
it('checks the condition again after submission simulation and never sends a replaced unmet sample', async () => {
  const review = await reviewed();
  await sign(review.id);
  mocks.simulate.mockImplementationOnce(async () => {
    await market(99);
    return f.simulation;
  });
  expect(
    (
      await post({
        action: 'submit',
        id: review.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(409);
  expect(mocks.rpc.mock.calls.some((c) => c[1] === 'sendTransaction')).toBe(
    false,
  );
  expect(await count('conditional_level_fills')).toBe(0);
});
it('cancels only an unsigned approval, releases both locks and never cancels a registered signature', async () => {
  const review = await reviewed();
  expect((await post({ action: 'cancel', id: review.id })).status).toBe(200);
  expect(await count('conditional_level_reservations')).toBe(0);
  expect(await count('solana_swap_reservations')).toBe(0);
  expect(await count('conditional_level_fills')).toBe(0);
  expect(
    (
      await post({
        action: 'register',
        id: review.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(409);
});
it('retains an expired signed packet for recovery and blocks a new owner from using the approval', async () => {
  const review = await reviewed();
  const clock = Date.now;
  vi.spyOn(Date, 'now').mockReturnValue(clock() + 60000);
  try {
    await sign(review.id);
    expect(
      (
        await post({
          action: 'submit',
          id: review.id,
          transaction: f.signed.transaction,
        })
      ).status,
    ).toBe(409);
  } finally {
    vi.restoreAllMocks();
  }
  expect((await post({ action: 'cancel', id: review.id })).status).toBe(409);
  mocks.user = { userId: 'other' };
  expect((await post({ action: 'recover', id: review.id })).status).toBe(404);
  mocks.user = { userId: owner };
  expect((await post({ action: 'recover', id: review.id })).status).toBe(200);
});
it('requires the exact approved signed packet before registration and preserves the level on mismatch', async () => {
  const review = await reviewed();
  const other = await nativeWarmupFixture({
    side: 'Buy',
    lookup: true,
    v2: true,
  });
  expect(other.signed.transaction).not.toBe(f.signed.transaction);
  expect(
    (
      await post({
        action: 'register',
        id: review.id,
        transaction: other.signed.transaction,
      })
    ).status,
  ).toBe(400);
  expect(await count('conditional_level_reservations')).toBe(1);
});

async function replaceBeforeWrite(prefix: string) {
  const original = mocks.db;
  mocks.db = new Proxy(original, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith(prefix)) return statement;
          return new Proxy(statement, {
            get(stmt, member) {
              if (member === 'bind')
                return (...values: unknown[]) => ({
                  run: async () => {
                    await market(99);
                    return stmt.bind(...values).run();
                  },
                });
              const value = Reflect.get(stmt, member);
              return typeof value === 'function' ? value.bind(stmt) : value;
            },
          });
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return () => {
    mocks.db = original;
  };
}
it('atomically rejects market replacement between the last approval check and reservation insertion', async () => {
  const restore = await replaceBeforeWrite(
    'INSERT OR IGNORE INTO imported_swap_signing_intents',
  );
  try {
    expect(
      (
        await post({
          action: 'review',
          preparationId,
          transaction: f.order.preparation.transaction,
        })
      ).status,
    ).toBe(409);
  } finally {
    restore();
  }
  expect(await count('conditional_level_reservations')).toBe(0);
  expect(await count('solana_swap_reservations')).toBe(0);
});
it('atomically withholds submission when the market document changes after the last condition check', async () => {
  const review = await reviewed();
  await sign(review.id);
  const restore = await replaceBeforeWrite(
    "UPDATE imported_swap_signing_intents SET state='submitted'",
  );
  try {
    expect(
      (
        await post({
          action: 'submit',
          id: review.id,
          transaction: f.signed.transaction,
        })
      ).status,
    ).toBe(409);
  } finally {
    restore();
  }
  expect(mocks.rpc.mock.calls.some((c) => c[1] === 'sendTransaction')).toBe(
    false,
  );
  expect(await count('conditional_level_reservations')).toBe(1);
});
