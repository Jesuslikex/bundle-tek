import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { env } from 'cloudflare:workers';
import { nativeWarmupFixture } from '../../../../test/warmup-native-fixture';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string } | null,
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
vi.mock('@/lib/warmup-swap-quote', async (original) => ({
  ...(await original<typeof import('@/lib/warmup-swap-quote')>()),
  prepareSolanaSwap: (...args: unknown[]) => mocks.prepare(...args),
}));
vi.mock('@/lib/imported-swap-balance', async (original) => ({
  ...(await original<typeof import('@/lib/imported-swap-balance')>()),
  observeImportedSwapBalance: (...args: unknown[]) => mocks.balance(...args),
}));
import { POST, GET } from './route';
import {
  POST as conditionalPost,
  GET as conditionalGet,
} from '../conditional-orders/route';
import { prepareOwnedImportedSwap } from '@/lib/prepare-owned-imported-swap';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import {
  conditionalOrderTerms,
  type ConditionalOrder,
} from '@/lib/conditional-order';
import type { WarmupSigningReview } from '@/lib/warmup-signing';
import { decodeWarmupReceipt } from '@/lib/warmup-buy-receipt';
import {
  configureConditionalMonitor,
  readConditionalMonitor,
  runConditionalMonitors,
} from '@/lib/conditional-monitor-server';
import type { SavedSwapPreparation } from '@/lib/imported-swap-preparation-history';
const fixtureEnv = env as unknown as Record<string, string | undefined>;
const { unstable_splitSqlQuery: splitHostedSql } = createRequire(
  import.meta.url,
)('wrangler') as { unstable_splitSqlQuery: (sql: string) => string[] };
let mf: Miniflare;
let owner: string;
let orderId: string;
let f: Awaited<ReturnType<typeof nativeWarmupFixture>>;
const projectId = '11111111-1111-4111-8111-111111111111';
const request = (path: string, body: object) =>
  new Request(`http://localhost/api/imported-projects/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const post = (body: object) => POST(request('signing', body));
const orderPost = (body: object) =>
  conditionalPost(request('conditional-orders', body));
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'conditional-buy-tests',
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
          env: { DB: { type: 'd1', id: 'conditional-buy-local-only' } },
        },
      },
    ],
  });
  mocks.db = await mf.getD1Database('DB', 'conditional-buy-tests');
  const journal = JSON.parse(
    await readFile(
      new URL('../../../../drizzle/meta/_journal.json', import.meta.url),
      'utf8',
    ),
  ) as { entries: { tag: string }[] };
  for (const entry of journal.entries) {
    const sql = await readFile(
      new URL(`../../../../drizzle/${entry.tag}.sql`, import.meta.url),
      'utf8',
    );
    const statements =
      entry.tag === '0072_conditional_buy_approval'
        ? splitHostedSql(sql)
        : sql.split('--> statement-breakpoint').filter((s) => s.trim());
    if (entry.tag === '0072_conditional_buy_approval')
      expect(statements).toHaveLength(5);
    for (const statement of statements) await mocks.db.prepare(statement).run();
  }
  const capabilities = await mocks.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('conditional_approval_reserve','conditional_intent_finalize','conditional_buy_approval_capability')",
    )
    .all();
  expect(capabilities.results).toHaveLength(3);
});
afterAll(async () => {
  delete fixtureEnv.JUPITER_API_KEY;
  await mf?.dispose();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  owner = crypto.randomUUID();
  orderId = crypto.randomUUID();
  mocks.user = { userId: owner };
  f = await nativeWarmupFixture({ side: 'Buy', lookup: true, v2: true });
  const now = new Date().toISOString();
  await mocks.db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,?,?,1,0,?,?)')
    .bind(
      owner,
      projectId,
      'Solana',
      f.mint,
      JSON.stringify({
        token: { chain: 'Solana', address: f.mint, decimals: 6 },
      }),
      crypto.randomUUID(),
      now,
    )
    .run();
  await mocks.db
    .prepare(
      'INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,revision,archived,updated_at) VALUES(?,?,?,?,?,?,1,0,?)',
    )
    .bind(owner, 'Solana', f.wallet, '', 'Fixture', 'Recipient', now)
    .run();
  fixtureEnv.JUPITER_API_KEY = 'synthetic-test-only';
  mocks.prepare.mockReset().mockResolvedValue(f.order);
  mocks.simulate.mockReset().mockResolvedValue(f.simulation);
  mocks.balance.mockReset().mockResolvedValue({
    executionAllowed: false,
    wallet: f.wallet,
    side: 'Buy',
    mint: f.mint,
    requestedRaw: f.order.inAmount,
    amountCovered: true,
    preparationSupported: true,
    source: 'fixture.test',
    observedAt: now,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    nativeSlot: 100,
  });
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
  await market(90);
});
async function market(cap: number, age = 0) {
  const observedAt = new Date(Date.now() - age).toISOString();
  const document = JSON.stringify([
    {
      chain: 'Solana',
      address: f.mint,
      projectRevision: 1,
      source: 'api.dexscreener.com',
      executionAllowed: false,
      observedAt,
      pairs: [{ address: f.mint, marketCapUsd: cap }],
    },
  ]);
  await mocks.db
    .prepare(
      'INSERT INTO imported_market_observations(owner_id,project_id,document,observed_at) VALUES(?,?,?,?) ON CONFLICT(owner_id,project_id) DO UPDATE SET document=excluded.document,observed_at=excluded.observed_at',
    )
    .bind(owner, projectId, document, observedAt)
    .run();
}
function createBody(kind: 'limit' | 'grid' = 'limit', patch: object = {}) {
  return {
    action: 'create',
    orderId,
    projectId,
    projectRevision: 1,
    wallet: f.wallet,
    walletRevision: 1,
    pair: f.mint,
    kind,
    direction: 'at-or-below',
    side: 'Buy',
    ...(kind === 'limit'
      ? { amount: '0.001', targetUsd: '100' }
      : { amount: '0.002', minimumUsd: '100', maximumUsd: '200', lines: 2 }),
    ...patch,
  };
}
async function create(kind: 'limit' | 'grid' = 'limit') {
  const response = await orderPost(createBody(kind));
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(
    200,
  );
  return ((await response.json()) as { order: ConditionalOrder }).order;
}
async function prepare(level = 1, patch: object = {}) {
  return prepareOwnedImportedSwap(
    request('prepare-swap', {
      id: projectId,
      revision: 1,
      wallet: f.wallet,
      walletRevision: 1,
      side: 'Buy',
      amount: '0.001',
      conditional: { orderId, revision: 1, level },
      ...patch,
    }),
    owner,
    mocks.db,
  );
}
async function prepared(kind: 'limit' | 'grid' = 'limit') {
  await create(kind);
  const response = await prepare();
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(
    200,
  );
  const result = (await response.json()) as {
    history: { id: string; document: { conditional: unknown } };
  };
  await mocks.db
    .prepare(
      'UPDATE wallet_balance_gates SET next_allowed_at=0 WHERE owner_id=?',
    )
    .bind(owner)
    .run();
  return result.history;
}
async function reviewed(preparationId: string) {
  const response = await post({
    action: 'review',
    preparationId,
    transaction: f.order.preparation.transaction,
  });
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(
    200,
  );
  return ((await response.json()) as { review: WarmupSigningReview }).review;
}
async function register(id: string) {
  expect(
    (await post({ action: 'register', id, transaction: f.signed.transaction }))
      .status,
  ).toBe(200);
}
async function count(table: string) {
  return (await mocks.db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_id=?`)
    .bind(owner)
    .first<{ n: number }>())!.n;
}
it('does not retain a monitor match when an explicit approval reserves the level during its provider read', async () => {
  await mocks.db.prepare('UPDATE conditional_monitor_jobs SET enabled=0').run();
  const history = await prepared();
  await configureConditionalMonitor(mocks.db, owner, {
    projectId,
    projectRevision: 1,
    monitorRevision: 0,
    enabled: true,
  });
  const fetcher = vi.fn(async () => {
    await reviewed(history.id);
    return Response.json([
      {
        chainId: 'solana',
        dexId: 'raydium',
        pairAddress: f.mint,
        baseToken: { address: f.mint },
        quoteToken: {
          address: 'So11111111111111111111111111111111111111112',
          symbol: 'SOL',
        },
        marketCap: 50,
        priceUsd: '1',
      },
    ]);
  });
  await runConditionalMonitors(mocks.db, fetcher);
  const p = await readConditionalMonitor(mocks.db, owner, projectId);
  expect(p?.notices).toHaveLength(0);
  expect(p?.monitor?.error).toBe('context-changed');
  expect(await count('conditional_level_reservations')).toBe(1);
  expect(mocks.rpc.mock.calls.some((c) => c[1] === 'sendTransaction')).toBe(
    false,
  );
});
it('skips provider reads for a level already reserved by its genuine approval', async () => {
  await mocks.db.prepare('UPDATE conditional_monitor_jobs SET enabled=0').run();
  const history = await prepared();
  await reviewed(history.id);
  await configureConditionalMonitor(mocks.db, owner, {
    projectId,
    projectRevision: 1,
    monitorRevision: 0,
    enabled: true,
  });
  const fetcher = vi.fn();
  await runConditionalMonitors(mocks.db, fetcher);
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    (await readConditionalMonitor(mocks.db, owner, projectId))?.monitor?.error,
  ).toBe('no-current-orders');
  expect(await count('conditional_level_reservations')).toBe(1);
});
it.each(['limit', 'grid'] as const)(
  'runs a real conditional Buy %s through explicit review, registration, one submission and exact finalized fill',
  async (kind) => {
    const history = await prepared(kind);
    expect(history.document.conditional).toMatchObject({
      format: 'conditional-preparation-v2',
      side: 'Buy',
      inputDecimals: 9,
      outputDecimals: 6,
      unitsRaw: '1000000',
    });
    const review = await reviewed(history.id);
    expect(review.conditional).toEqual(history.document.conditional);
    expect(await count('conditional_level_reservations')).toBe(1);
    expect(
      mocks.rpc.mock.calls.some((call) => call[1] === 'sendTransaction'),
    ).toBe(false);
    await register(review.id);
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
    expect(
      mocks.rpc.mock.calls.filter((call) => call[1] === 'sendTransaction'),
    ).toHaveLength(1);
    const recovered = await post({ action: 'recover', id: review.id });
    expect(
      recovered.status,
      JSON.stringify(await recovered.clone().json()),
    ).toBe(200);
    const outcome = (await recovered.json()) as {
      state: string;
      receipt: {
        createdAt: string;
        document: {
          observedAt: string;
          quoteUnitsRaw: string;
          tokenUnitsRaw: string;
          nativeSettlementRaw: string;
        };
      };
    };
    expect(outcome.state).toBe('finalized');
    expect(outcome.receipt.document).toMatchObject({
      quoteUnitsRaw: '1000000',
      tokenUnitsRaw: '1000',
      nativeSettlementRaw: '-1000000',
    });
    expect(await count('conditional_level_fills')).toBe(1);
    expect(await count('conditional_level_reservations')).toBe(0);
    expect(await count('solana_swap_reservations')).toBe(0);
    expect((await post({ action: 'recover', id: review.id })).status).toBe(200);
    expect(await count('conditional_level_fills')).toBe(1);
    const approval = await mocks.db
      .prepare(
        'SELECT updated_at AS updatedAt FROM imported_swap_signing_intents WHERE owner_id=? AND id=?',
      )
      .bind(owner, review.id)
      .first<{ updatedAt: string }>();
    expect(Date.parse(outcome.receipt.document.observedAt)).toBeLessThanOrEqual(
      Date.parse(approval!.updatedAt),
    );
    const page = await conditionalGet(
      new Request(
        `http://localhost/api/imported-projects/conditional-orders?projectId=${projectId}`,
      ),
    );
    expect(page.status).toBe(200);
    expect(
      ((await page.json()) as { levels: unknown[] }).levels[0],
    ).toMatchObject({
      state: 'filled',
      intentId: review.id,
      unitsRaw: '1000000',
    });
    const intents = await GET(
      new Request(
        `http://localhost/api/imported-projects/signing?projectId=${projectId}&intentId=${review.id}`,
      ),
    );
    expect(intents.status).toBe(200);
    expect(
      (
        (await intents.json()) as {
          intents: { document: { conditional: unknown } }[];
        }
      ).intents[0].document.conditional,
    ).toEqual(review.conditional);
  },
);
it('fails Buy creation and preparation before provider work when the capability migration is absent', async () => {
  await mocks.db
    .prepare('DROP TRIGGER conditional_buy_approval_capability')
    .run();
  try {
    expect((await orderPost(createBody())).status).toBe(503);
    const terms = conditionalOrderTerms(createBody(), {
      chain: 'Solana',
      address: f.mint,
      decimals: 6,
    });
    const now = new Date().toISOString();
    await mocks.db
      .prepare(
        "INSERT INTO conditional_sell_orders VALUES(?,?,?,?,'draft',1,?,?)",
      )
      .bind(owner, orderId, projectId, JSON.stringify(terms), now, now)
      .run();
    const unsupported = await prepare();
    expect(unsupported.status).toBe(503);
    expect(((await unsupported.json()) as { error: string }).error).toContain(
      'Conditional Buy storage is not upgraded',
    );
    expect(mocks.balance).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.simulate).not.toHaveBeenCalled();
  } finally {
    const sql = await readFile(
      new URL(
        '../../../../drizzle/0072_conditional_buy_approval.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await mocks.db.prepare(sql.split('--> statement-breakpoint').at(-1)!).run();
  }
});
it('supports a Buy limit above the target as an explicit SOL-input breakout condition', async () => {
  expect(
    (await orderPost(createBody('limit', { direction: 'at-or-above' }))).status,
  ).toBe(200);
  await market(110);
  const response = await prepare();
  expect(response.status).toBe(200);
  const history = ((await response.json()) as { history: { id: string } })
    .history;
  await mocks.db
    .prepare(
      'UPDATE wallet_balance_gates SET next_allowed_at=0 WHERE owner_id=?',
    )
    .bind(owner)
    .run();
  const review = await reviewed(history.id);
  expect(review.conditional).toMatchObject({
    side: 'Buy',
    direction: 'at-or-above',
    unitsRaw: '1000000',
  });
  expect(
    mocks.rpc.mock.calls.some((call) => call[1] === 'sendTransaction'),
  ).toBe(false);
});
it.each(['review', 'submit'] as const)(
  'withholds Buy %s before provider checks when upgraded storage capability disappears',
  async (action) => {
    const history = await prepared();
    const review = action === 'submit' ? await reviewed(history.id) : null;
    if (review) await register(review.id);
    mocks.simulate.mockClear();
    mocks.rpc.mockClear();
    await mocks.db
      .prepare('DROP TRIGGER conditional_buy_approval_capability')
      .run();
    try {
      const response = await post(
        action === 'review'
          ? {
              action,
              preparationId: history.id,
              transaction: f.order.preparation.transaction,
            }
          : { action, id: review!.id, transaction: f.signed.transaction },
      );
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: string }).error).toContain(
        'Conditional Buy storage is not upgraded',
      );
      expect(mocks.simulate).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    } finally {
      const sql = await readFile(
        new URL(
          '../../../../drizzle/0072_conditional_buy_approval.sql',
          import.meta.url,
        ),
        'utf8',
      );
      await mocks.db
        .prepare(sql.split('--> statement-breakpoint').at(-1)!)
        .run();
    }
  },
);
it.each([
  { side: 'Sell' },
  { amount: '0.000001' },
  {
    conditional: {
      orderId: '99999999-9999-4999-8999-999999999999',
      revision: 1,
      level: 1,
    },
  },
  { revision: 2 },
  { walletRevision: 2 },
])(
  'rejects mismatched Buy preparation context before quoting: %j',
  async (patch) => {
    await create();
    expect((await prepare(1, patch)).status).toBe(409);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.balance).not.toHaveBeenCalled();
  },
);
it.each([
  {
    direction: 'at-or-above',
    kind: 'grid',
    amount: '0.002',
    minimumUsd: '100',
    maximumUsd: '200',
    lines: 2,
  },
  { amount: '0.0000000001' },
  { side: 'Other' },
])('rejects invalid Buy order inputs: %j', async (patch) => {
  const body = createBody('limit', patch) as Record<string, unknown>;
  if (patch.kind === 'grid') delete body.targetUsd;
  expect((await orderPost(body)).status).toBe(400);
  expect(await count('conditional_sell_orders')).toBe(0);
});
it('requires an owned active wallet and project to save Buy orders', async () => {
  mocks.user = { userId: 'foreign' };
  expect((await orderPost(createBody())).status).toBe(404);
  mocks.user = { userId: owner };
  await mocks.db
    .prepare(
      'UPDATE workspace_wallets SET archived=1,revision=2 WHERE owner_id=?',
    )
    .bind(owner)
    .run();
  expect((await orderPost(createBody())).status).toBe(409);
  expect(await count('conditional_sell_orders')).toBe(0);
});
it('checks fresh unmet/stale market conditions at preparation and review without creating locks', async () => {
  await create();
  await market(101);
  expect((await prepare()).status).toBe(409);
  await market(90, 31000);
  expect((await prepare()).status).toBe(409);
  expect(mocks.prepare).not.toHaveBeenCalled();
  await market(90);
  const response = await prepare();
  expect(response.status).toBe(200);
  const history = ((await response.json()) as { history: { id: string } })
    .history;
  await market(101);
  mocks.simulate.mockClear();
  expect(
    (
      await post({
        action: 'review',
        preparationId: history.id,
        transaction: f.order.preparation.transaction,
      })
    ).status,
  ).toBe(409);
  expect(mocks.simulate).not.toHaveBeenCalled();
  expect(await count('conditional_level_reservations')).toBe(0);
});
it('rechecks market after preparation simulation and refuses to save a replaced unmet sample', async () => {
  await create();
  mocks.simulate.mockImplementationOnce(async () => {
    await market(101);
    return f.simulation;
  });
  expect((await prepare()).status).toBe(409);
  expect(await count('imported_swap_preparations')).toBe(0);
});
it('withholds submission after a market change, retains the signed reservation and recovers across archives', async () => {
  const history = await prepared();
  const review = await reviewed(history.id);
  await register(review.id);
  mocks.simulate.mockImplementationOnce(async () => {
    await market(101);
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
  expect(
    mocks.rpc.mock.calls.some((call) => call[1] === 'sendTransaction'),
  ).toBe(false);
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
it('does not register another exact packet or let another owner recover a Buy approval', async () => {
  const history = await prepared();
  const review = await reviewed(history.id);
  const other = await nativeWarmupFixture({
    side: 'Sell',
    lookup: true,
    v2: true,
  });
  expect(
    (
      await post({
        action: 'register',
        id: review.id,
        transaction: other.signed.transaction,
      })
    ).status,
  ).toBe(400);
  await register(review.id);
  mocks.user = { userId: 'foreign' };
  expect((await post({ action: 'recover', id: review.id })).status).toBe(404);
  expect(await count('conditional_level_fills')).toBe(0);
});
it('timestamps finalized history after delayed receipt decoding rather than before its RPC observation', async () => {
  const history = await prepared();
  const review = await reviewed(history.id);
  await register(review.id);
  const start = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
  mocks.rpc.mockImplementation(async (_endpoint, method) => {
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getTransaction') {
      vi.setSystemTime(start + 10000);
      return f.receipt;
    }
    return null;
  });
  try {
    const response = await post({ action: 'recover', id: review.id });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      receipt: { createdAt: string; document: { observedAt: string } };
    };
    expect(Date.parse(result.receipt.document.observedAt)).toBe(start + 10000);
    expect(Date.parse(result.receipt.createdAt)).toBe(start + 10000);
    const event = await mocks.db
      .prepare(
        'SELECT updated_at AS updatedAt FROM imported_swap_signing_intents WHERE owner_id=? AND id=?',
      )
      .bind(owner, review.id)
      .first<{ updatedAt: string }>();
    expect(Date.parse(event!.updatedAt)).toBe(start + 10000);
  } finally {
    vi.useRealTimers();
  }
});
it('keeps existing legacy Sell captures valid under the appended Buy reservation/fill triggers', async () => {
  f = await nativeWarmupFixture({ side: 'Sell', lookup: true, v2: true });
  mocks.prepare.mockResolvedValue(f.order);
  mocks.simulate.mockResolvedValue(f.simulation);
  mocks.balance.mockResolvedValue({
    executionAllowed: false,
    wallet: f.wallet,
    side: 'Sell',
    mint: f.mint,
    requestedRaw: f.order.inAmount,
    amountCovered: true,
    preparationSupported: true,
    source: 'fixture.test',
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    nativeSlot: 100,
  });
  await market(110);
  expect(
    (
      await orderPost(
        createBody('limit', { side: 'Sell', direction: 'at-or-above' }),
      )
    ).status,
  ).toBe(200);
  const response = await prepare(1, { side: 'Sell' });
  expect(response.status).toBe(200);
  const history = (
    (await response.json()) as {
      history: { id: string; document: { conditional: { format: string } } };
    }
  ).history;
  expect(history.document.conditional.format).toBe(
    'conditional-preparation-v1',
  );
  await mocks.db
    .prepare(
      'UPDATE wallet_balance_gates SET next_allowed_at=0 WHERE owner_id=?',
    )
    .bind(owner)
    .run();
  const review = await reviewed(history.id);
  await register(review.id);
  expect((await post({ action: 'recover', id: review.id })).status).toBe(200);
  const fill = await mocks.db
    .prepare(
      'SELECT units_raw AS unitsRaw FROM conditional_level_fills WHERE owner_id=?',
    )
    .bind(owner)
    .first<{ unitsRaw: string }>();
  expect(fill!.unitsRaw).toBe('1000');
});
it.each([
  { quoteUnitsRaw: '1000' },
  { nativeSettlementRaw: '-999999' },
  { tokenUnitsRaw: '994' },
  { tokenUnitsRaw: '0995' },
  { tokenUnitsRaw: '18446744073709551616' },
  { decimals: 9 },
  { side: 'Sell' },
  { preparationSha256: 'b'.repeat(64) },
  { mint: '11111111111111111111111111111111' },
])(
  'rejects a forged finalized Buy fill atomically while retaining the signed level: %j',
  async (patch) => {
    const history = await prepared();
    const review = await reviewed(history.id);
    await register(review.id);
    const saved = await mocks.db
      .prepare(
        'SELECT document FROM imported_swap_preparations WHERE owner_id=? AND id=?',
      )
      .bind(owner, history.id)
      .first<{ document: string }>();
    const document = JSON.parse(
      saved!.document,
    ) as SavedSwapPreparation['document'];
    const { acquiredRaw, ...evidence } = await decodeWarmupReceipt(
      f.receipt,
      { document },
      f.signed.signature,
      'Buy',
      review,
    );
    const receiptDocument = {
      ...evidence,
      side: 'Buy',
      tokenUnitsRaw: acquiredRaw,
      quoteUnitsRaw: '1000000',
      source: 'fixture.test',
      observedAt: new Date().toISOString(),
      ...patch,
    };
    const receiptId = crypto.randomUUID();
    const now = new Date().toISOString();
    await expect(
      mocks.db.batch([
        mocks.db
          .prepare(
            'INSERT INTO imported_swap_receipts VALUES(?,?,?,?,?,?,?,?,?,?)',
          )
          .bind(
            receiptId,
            owner,
            review.id,
            history.id,
            projectId,
            1,
            1,
            f.signed.signature,
            JSON.stringify(receiptDocument),
            now,
          ),
        mocks.db
          .prepare(
            "UPDATE imported_swap_signing_intents SET state='finalized',updated_at=? WHERE owner_id=? AND id=?",
          )
          .bind(now, owner, review.id),
      ]),
    ).rejects.toThrow('Conditional fill lacks its exact finalized receipt');
    expect(await count('imported_swap_receipts')).toBe(0);
    expect(await count('conditional_level_fills')).toBe(0);
    expect(await count('conditional_level_reservations')).toBe(1);
    const retained = await mocks.db
      .prepare(
        'SELECT state FROM imported_swap_signing_intents WHERE owner_id=? AND id=?',
      )
      .bind(owner, review.id)
      .first<{ state: string }>();
    expect(retained!.state).toBe('signed');
  },
);
async function replaceBeforeWrite(
  prefix: string,
  beforeWrite: (values: unknown[]) => Promise<unknown> = () => market(101),
) {
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
                    await beforeWrite(values);
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
it('does not retain a conditional preparation whose observation expires while its INSERT is queued', async () => {
  await create();
  await market(90, 28000);
  let attempted = false;
  const restore = await replaceBeforeWrite(
    'INSERT INTO imported_swap_preparations',
    async (values) => {
      attempted = true;
      const expiresAt = values.at(-1);
      expect(typeof expiresAt).toBe('string');
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(1, Date.parse(expiresAt as string) - Date.now() + 200),
        ),
      );
    },
  );
  try {
    expect((await prepare()).status).toBe(409);
  } finally {
    restore();
  }
  expect(attempted).toBe(true);
  expect(mocks.simulate).toHaveBeenCalledOnce();
  expect(await count('imported_swap_preparations')).toBe(0);
});
it('atomically rejects market replacement after the final approval check without acquiring locks', async () => {
  const history = await prepared();
  const restore = await replaceBeforeWrite(
    'INSERT OR IGNORE INTO imported_swap_signing_intents',
  );
  try {
    expect(
      (
        await post({
          action: 'review',
          preparationId: history.id,
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
it('atomically withholds a send when the market changes between the last check and submitted-state write', async () => {
  const history = await prepared();
  const review = await reviewed(history.id);
  await register(review.id);
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
  expect(
    mocks.rpc.mock.calls.some((call) => call[1] === 'sendTransaction'),
  ).toBe(false);
  expect(await count('conditional_level_reservations')).toBe(1);
});
it('records an exact failed Buy after delayed RPC observation, releases locks and never marks the level filled', async () => {
  const history = await prepared();
  const review = await reviewed(history.id);
  await register(review.id);
  const raw = {
    ...structuredClone(f.receipt),
    meta: {
      ...structuredClone(f.receipt.meta),
      err: { InstructionError: [1, 'InsufficientFunds'] },
      postBalances: [...f.receipt.meta.preBalances],
    },
  };
  raw.meta.postBalances[0] = (
    BigInt(raw.meta.preBalances[0]) - BigInt(raw.meta.fee)
  ).toString();
  const start = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
  mocks.rpc.mockImplementation(async (_endpoint, method) => {
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getTransaction') {
      vi.setSystemTime(start + 10000);
      return raw;
    }
    return null;
  });
  try {
    const response = await post({ action: 'recover', id: review.id });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(
      200,
    );
    const result = (await response.json()) as {
      state: string;
      failureReceipt: { observedAt: string };
    };
    expect(result.state).toBe('failed');
    const event = await mocks.db
      .prepare(
        'SELECT updated_at AS updatedAt FROM imported_swap_signing_intents WHERE owner_id=? AND id=?',
      )
      .bind(owner, review.id)
      .first<{ updatedAt: string }>();
    expect(Date.parse(event!.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(result.failureReceipt.observedAt),
    );
    expect(Date.parse(event!.updatedAt)).toBe(start + 10000);
    expect(await count('conditional_level_fills')).toBe(0);
    expect(await count('conditional_level_reservations')).toBe(0);
    expect(await count('solana_swap_reservations')).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
it.each(['prepare', 'review', 'submit'] as const)(
  'rejects observed target-token precision substitution during Buy %s',
  async (action) => {
    let preparationId: string | undefined;
    let review: WarmupSigningReview | undefined;
    if (action === 'prepare') await create();
    else {
      preparationId = (await prepared()).id;
      if (action === 'submit') {
        review = await reviewed(preparationId);
        await register(review.id);
      }
    }
    mocks.simulate.mockResolvedValue({
      ...f.simulation,
      tokenChanges: f.simulation.tokenChanges.map((change) =>
        change.mint === f.mint ? { ...change, decimals: 9 } : change,
      ),
    });
    const response =
      action === 'prepare'
        ? await prepare()
        : await post(
            action === 'review'
              ? {
                  action,
                  preparationId,
                  transaction: f.order.preparation.transaction,
                }
              : { action, id: review!.id, transaction: f.signed.transaction },
          );
    expect(response.status).toBe(action === 'prepare' ? 502 : 409);
    expect(
      mocks.rpc.mock.calls.some((call) => call[1] === 'sendTransaction'),
    ).toBe(false);
    if (action === 'prepare')
      expect(await count('imported_swap_preparations')).toBe(0);
    expect(await count('conditional_level_reservations')).toBe(
      action === 'submit' ? 1 : 0,
    );
  },
);
it('withholds recovery and preserves signed reservations when finalized output precision differs from the captured mint', async () => {
  const history = await prepared();
  const review = await reviewed(history.id);
  await register(review.id);
  const raw = structuredClone(f.receipt);
  for (const balances of [
    raw.meta.preTokenBalances,
    raw.meta.postTokenBalances,
  ])
    for (const balance of balances)
      if (balance.mint === f.mint) balance.uiTokenAmount.decimals = '9';
  mocks.rpc.mockImplementation(async (_endpoint, method) =>
    method === 'getGenesisHash'
      ? SOLANA_MAINNET_GENESIS
      : method === 'getTransaction'
        ? raw
        : null,
  );
  expect((await post({ action: 'recover', id: review.id })).status).toBe(409);
  expect(await count('imported_swap_receipts')).toBe(0);
  expect(await count('conditional_level_fills')).toBe(0);
  expect(await count('conditional_level_reservations')).toBe(1);
});
