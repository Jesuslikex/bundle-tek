import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
import { env } from 'cloudflare:workers';
import { POST as prepareImported } from '../prepare/route';
import {
  POST as jobPost,
  GET as jobGet,
} from '../session-preparation-jobs/route';
import { runSessionPreparationJobs } from '@/lib/session-preparation-jobs';
import { prepareOwnedImportedSwap } from '@/lib/prepare-owned-imported-swap';
import { POST, GET as approvalGet } from './route';
import {
  POST as sessionPost,
  GET as sessionGet,
} from '../trade-sessions/route';
import { GET as sessionEvents } from '../session-events/route';
import { GET as jobEvents } from '../session-job-events/route';
import {
  captureTradeSession,
  tradeSessionWriteGuard,
} from '@/lib/imported-trade-session-server';
import { tradeSessionTerms } from '@/lib/imported-trade-session';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
let mf: Miniflare;
let f: Awaited<ReturnType<typeof nativeWarmupFixture>>;
const projectId = '11111111-1111-4111-8111-111111111111';
let preparationId: string, owner: string, sessionId: string;
let oldMigrationEvent: unknown;
const legacySessionId = '00000000-0000-4000-8000-000000000061';
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'session-signing-test',
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
  mocks.db = await mf.getD1Database('DB', 'session-signing-test');
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
  for (const name of [
    '0024_imported_token_projects',
    '0033_imported_market_observations',
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
    '0068_remarkable_frightful_four',
    '0074_dca_trade_session_timing',
    '0075_dca_session_end_time',
  ]) {
    if (name === '0061_imported_trade_session_controls') {
      const now = new Date().toISOString(),
        terms = tradeSessionTerms(
          {
            projectId,
            projectRevision: 1,
            side: 'Buy',
            entries: [
              {
                wallet: '11111111111111111111111111111111',
                walletRevision: 1,
                amount: '0.001',
              },
            ],
          },
          {
            chain: 'Solana',
            address: 'So11111111111111111111111111111111111111112',
            decimals: 6,
          },
        );
      await mocks.db
        .prepare(
          "INSERT INTO imported_trade_sessions VALUES(?,?,?,?,'active',1,?,?)",
        )
        .bind(
          'legacy-control-fixture',
          legacySessionId,
          projectId,
          JSON.stringify(terms),
          now,
          now,
        )
        .run();
      oldMigrationEvent = await mocks.db
        .prepare(
          'SELECT sequence,id,owner_id,project_id,session_id,type,document,approval,created_at FROM imported_trade_session_events WHERE owner_id=?',
        )
        .bind('legacy-control-fixture')
        .first();
    }
    const sql = await readFile(
      new URL(`../../../../drizzle/${name}.sql`, import.meta.url),
      'utf8',
    );
    for (const statement of sql
      .split('--> statement-breakpoint')
      .filter((s) => s.trim()))
      await mocks.db.prepare(statement).run();
  }
  f = await nativeWarmupFixture({ lookup: true, v2: true });
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
  sessionId = crypto.randomUUID();
  mocks.user = { userId: owner };
  f = await nativeWarmupFixture({ lookup: true, v2: true });
  await store(f);
  await mocks.db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,1,0)')
    .bind(owner, 'Solana', '11111111111111111111111111111111')
    .run();
  (env as unknown as Record<string, string>).JUPITER_API_KEY =
    'isolated-test-only';
  mocks.simulate.mockReset().mockResolvedValue(f.simulation);
  mocks.prepare.mockReset().mockResolvedValue(f.order);
  mocks.balance.mockReset().mockResolvedValue({
    executionAllowed: false,
    wallet: f.wallet,
    mint: f.mint,
    side: 'Buy',
    source: 'fixture.test',
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    requestedRaw: '1000000',
    amountCovered: true,
    preparationSupported: true,
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
});
const body = () => ({
  action: 'create',
  id: sessionId,
  projectId,
  projectRevision: 1,
  side: f.order.side,
  entries: [
    { wallet: f.wallet, walletRevision: 1, amount: '0.001' },
    {
      wallet: '11111111111111111111111111111111',
      walletRevision: 1,
      amount: '0.002',
    },
  ],
});
const request = (value: unknown) =>
  new Request('http://localhost/api/imported-projects/trade-sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
const post = (value: unknown) => POST(request(value));
async function create() {
  const response = await sessionPost(request(body()));
  expect(response.status).toBe(200);
  return response.json();
}
const dcaBody = () => ({
  ...body(),
  strategy: 'DCA',
  schedule: {
    startAt: new Date(Date.now() - 30000).toISOString(),
    spacingSeconds: 60,
  },
  entries: Array.from({ length: 2 }, () => ({
    wallet: f.wallet,
    walletRevision: 1,
    amount: '0.001',
  })),
});
async function rangeMarket(cap: number, observedAt = new Date().toISOString()) {
  const document = JSON.stringify([
    {
      chain: 'Solana',
      address: f.mint,
      projectRevision: 1,
      source: 'api.dexscreener.com',
      executionAllowed: false,
      observedAt,
      returnedPairCount: 1,
      quoteOnlyPairCount: 0,
      pairs: [
        {
          address: f.wallet,
          dex: 'fixture',
          url: 'https://dexscreener.com/solana/' + f.wallet,
          quoteSymbol: 'SOL',
          priceUsd: '1',
          liquidityUsd: 100,
          volume24hUsd: 100,
          change24h: 0,
          marketCapUsd: cap,
        },
      ],
    },
  ]);
  await mocks.db
    .prepare(
      'INSERT INTO imported_market_observations VALUES(?,?,?,?) ON CONFLICT(owner_id,project_id) DO UPDATE SET document=excluded.document,observed_at=excluded.observed_at',
    )
    .bind(owner, projectId, document, observedAt)
    .run();
}
async function boundedDca() {
  const response = await sessionPost(
    request({
      ...dcaBody(),
      schedule: {
        startAt: new Date(Date.now() - 30000).toISOString(),
        spacingSeconds: 1,
      },
      marketCapRange: { pair: f.wallet, minimumUsd: '100', maximumUsd: '200' },
    }),
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    session: { terms: ReturnType<typeof tradeSessionTerms> };
  }>;
}
const rangeCapture = () =>
  captureTradeSession(
    mocks.db,
    owner,
    { sessionId, revision: 1, entry: 1 },
    {
      projectId,
      projectRevision: 1,
      wallet: f.wallet,
      walletRevision: 1,
      side: 'Buy',
      unitsRaw: '1000000',
      mint: f.mint,
      decimals: 6,
    },
  );
it('enforces saved DCA bounds before quote/review/submission providers and preserves signed recovery', async () => {
  const saved = await boundedDca();
  expect(saved.session.terms.marketCapRange).toEqual({
    pair: f.wallet,
    minimumUsd: '100',
    maximumUsd: '200',
  });
  await rangeMarket(100);
  const guard = await rangeCapture();
  await mocks.db
    .prepare(
      "UPDATE imported_swap_preparations SET document=json_set(document,'$.session',json(?)) WHERE owner_id=? AND id=?",
    )
    .bind(JSON.stringify(guard.selection), owner, preparationId)
    .run();
  await rangeMarket(99);
  const quote = await prepareImported(
    new Request('http://localhost/api/imported-projects/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        revision: 1,
        wallet: f.wallet,
        walletRevision: 1,
        side: 'Buy',
        amount: '0.001',
        session: { sessionId, revision: 1, entry: 1 },
      }),
    }),
  );
  expect(quote.status).toBe(409);
  expect(((await quote.json()) as { error: string }).error).toContain(
    'outside the saved range',
  );
  expect(mocks.prepare).not.toHaveBeenCalled();
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
  await rangeMarket(200);
  const review = await reviewed();
  await rangeMarket(201);
  expect(
    (
      await post({
        action: 'register',
        id: review.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(200);
  const simulations = mocks.simulate.mock.calls.length;
  expect(
    (
      await post({
        action: 'submit',
        id: review.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(409);
  expect(mocks.simulate.mock.calls.length).toBe(simulations);
  expect(
    mocks.rpc.mock.calls.some((call) => call[1] === 'sendTransaction'),
  ).toBe(false);
  expect((await post({ action: 'recover', id: review.id })).status).toBe(200);
});
it('rejects changed market evidence atomically even when its new cap remains inside the saved range', async () => {
  await boundedDca();
  await rangeMarket(100);
  const guard = await rangeCapture();
  const write = tradeSessionWriteGuard(owner, guard);
  await rangeMarket(200);
  const changed = await mocks.db
    .prepare(
      'UPDATE imported_swap_preparations SET document=document WHERE owner_id=? AND id=?' +
        write.sql,
    )
    .bind(owner, preparationId, ...write.bindings)
    .run();
  expect(changed.meta.changes).toBe(0);
  const fresh = tradeSessionWriteGuard(owner, await rangeCapture());
  const unchanged = await mocks.db
    .prepare(
      'UPDATE imported_swap_preparations SET document=document WHERE owner_id=? AND id=?' +
        fresh.sql,
    )
    .bind(owner, preparationId, ...fresh.bindings)
    .run();
  expect(unchanged.meta.changes).toBe(1);
});
it('applies DCA market-cap bounds to Sell cycles with exact token precision', async () => {
  f = await nativeWarmupFixture({ side: 'Sell', lookup: true, v2: true });
  mocks.simulate.mockResolvedValue(f.simulation);
  const document = {
    ...unsignedPreparationSummary(f.order, f.simulation),
    balance: {
      source: 'fixture.test',
      observedAt: new Date().toISOString(),
      requestedRaw: '1000',
      amountCovered: true,
    },
  };
  await mocks.db
    .prepare(
      'UPDATE imported_swap_preparations SET document=? WHERE owner_id=? AND id=?',
    )
    .bind(JSON.stringify(document), owner, preparationId)
    .run();
  const saved = await boundedDca();
  expect(saved.session.terms.side).toBe('Sell');
  expect(saved.session.terms.entries[0].unitsRaw).toBe('1000');
  await rangeMarket(100);
  const guard = await captureTradeSession(
    mocks.db,
    owner,
    { sessionId, revision: 1, entry: 1 },
    {
      projectId,
      projectRevision: 1,
      wallet: f.wallet,
      walletRevision: 1,
      side: 'Sell',
      unitsRaw: '1000',
      mint: f.mint,
      decimals: 6,
    },
  );
  await mocks.db
    .prepare(
      "UPDATE imported_swap_preparations SET document=json_set(document,'$.session',json(?)) WHERE owner_id=? AND id=?",
    )
    .bind(JSON.stringify(guard.selection), owner, preparationId)
    .run();
  await rangeMarket(201);
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
  await rangeMarket(200);
  const review = await reviewed();
  expect(review.inputMint).toBe(f.mint);
  expect(review.session?.unitsRaw).toBe('1000');
});
it('uses database time to reject expired DCA market evidence captured by a lagging application clock', async () => {
  await boundedDca();
  const actual = Date.now();
  await rangeMarket(100, new Date(actual - 40000).toISOString());
  const clock = vi.spyOn(Date, 'now').mockReturnValue(actual - 20000);
  try {
    const write = tradeSessionWriteGuard(owner, await rangeCapture());
    const changed = await mocks.db
      .prepare(
        'UPDATE imported_swap_preparations SET document=document WHERE owner_id=? AND id=?' +
          write.sql,
      )
      .bind(owner, preparationId, ...write.bindings)
      .run();
    expect(changed.meta.changes).toBe(0);
  } finally {
    clock.mockRestore();
  }
});
it('closes DCA at its saved deadline before providers while preserving exact signature registration and receipt recovery', async () => {
  const endsAt = new Date(Date.now() + 60000).toISOString();
  const input = {
    ...dcaBody(),
    endsAt,
    schedule: {
      startAt: new Date(Date.now() - 30000).toISOString(),
      spacingSeconds: 1,
    },
  };
  expect((await sessionPost(request(input))).status).toBe(200);
  const guard = await captureTradeSession(
    mocks.db,
    owner,
    { sessionId, revision: 1, entry: 1 },
    {
      projectId,
      projectRevision: 1,
      wallet: f.wallet,
      walletRevision: 1,
      side: 'Buy',
      unitsRaw: '1000000',
      mint: f.mint,
      decimals: 6,
    },
  );
  await mocks.db
    .prepare(
      "UPDATE imported_swap_preparations SET document=json_set(document,'$.session',json(?)) WHERE owner_id=? AND id=?",
    )
    .bind(JSON.stringify(guard.selection), owner, preparationId)
    .run();
  const approval = await reviewed();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(endsAt));
  try {
    const earlyCalls = mocks.prepare.mock.calls.length;
    const prepared = await prepareImported(
      new Request('http://localhost/api/imported-projects/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: projectId,
          revision: 1,
          wallet: f.wallet,
          walletRevision: 1,
          side: 'Buy',
          amount: '0.001',
          session: { sessionId, revision: 1, entry: 2 },
        }),
      }),
    );
    expect(prepared.status).toBe(409);
    expect(mocks.prepare.mock.calls.length).toBe(earlyCalls);
    expect(
      (
        await post({
          action: 'register',
          id: approval.id,
          transaction: f.signed.transaction,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post({
          action: 'submit',
          id: approval.id,
          transaction: f.signed.transaction,
        })
      ).status,
    ).toBe(409);
    expect(
      mocks.rpc.mock.calls.some((call) => call[1] === 'sendTransaction'),
    ).toBe(false);
    expect((await post({ action: 'recover', id: approval.id })).status).toBe(
      200,
    );
  } finally {
    clock.mockRestore();
  }
});
it('enforces DCA expiry using the database clock even when the application clock is behind', async () => {
  const actual = Date.now();
  const input = {
    ...dcaBody(),
    endsAt: new Date(actual - 1000).toISOString(),
    schedule: {
      startAt: new Date(actual - 30000).toISOString(),
      spacingSeconds: 1,
    },
  };
  const clock = vi.spyOn(Date, 'now').mockReturnValue(actual - 5000);
  try {
    expect((await sessionPost(request(input))).status).toBe(409);
    expect(await count('imported_trade_sessions')).toBe(0);
  } finally {
    clock.mockRestore();
  }
  expect((await sessionPost(request(input))).status).toBe(400);
});
it('the database rejects an expired DCA preparation and stale write guard independently of the application clock', async () => {
  const actual = Date.now(),
    startAt = new Date(actual - 30000).toISOString(),
    endsAt = new Date(actual - 1000).toISOString();
  const terms = tradeSessionTerms(
    { ...dcaBody(), endsAt, schedule: { startAt, spacingSeconds: 1 } },
    { chain: 'Solana', address: f.mint, decimals: 6 },
  );
  // Retained historical session whose deadline has already passed.
  await mocks.db
    .prepare(
      "INSERT INTO imported_trade_sessions VALUES(?,?,?,?,'active',1,?,?)",
    )
    .bind(owner, sessionId, projectId, JSON.stringify(terms), startAt, startAt)
    .run();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(actual - 2000);
  let guard;
  try {
    guard = await captureTradeSession(
      mocks.db,
      owner,
      { sessionId, revision: 1, entry: 1 },
      {
        projectId,
        projectRevision: 1,
        wallet: f.wallet,
        walletRevision: 1,
        side: 'Buy',
        unitsRaw: '1000000',
        mint: f.mint,
        decimals: 6,
      },
    );
  } finally {
    clock.mockRestore();
  }
  const write = tradeSessionWriteGuard(owner, guard);
  expect(
    await mocks.db
      .prepare('SELECT 1 AS ready WHERE 1=1' + write.sql)
      .bind(...write.bindings)
      .first(),
  ).toBeNull();
  await expect(
    mocks.db
      .prepare(
        "INSERT INTO imported_swap_preparations SELECT ?,owner_id,project_id,project_revision,wallet_address,wallet_revision,json_set(document,'$.session',json(?)),created_at FROM imported_swap_preparations WHERE owner_id=? AND id=?",
      )
      .bind(
        crypto.randomUUID(),
        JSON.stringify(guard.selection),
        owner,
        preparationId,
      )
      .run(),
  ).rejects.toThrow(/timing differs/);
  expect(await count('imported_swap_preparations')).toBe(1);
});
it('saves repeated-wallet DCA terms idempotently and binds each cycle to its own due time before provider reads', async () => {
  const input = dcaBody();
  const first = await sessionPost(request(input));
  expect(first.status).toBe(200);
  const saved = (await first.json()) as {
    session: { terms: { strategy: string; format: string } };
  };
  expect(saved.session.terms).toMatchObject({
    strategy: 'DCA',
    format: 'imported-trade-session-v3',
  });
  expect((await sessionPost(request(input))).status).toBe(200);
  expect(
    (
      await sessionPost(
        request({
          ...input,
          schedule: { ...input.schedule, spacingSeconds: 61 },
        }),
      )
    ).status,
  ).toBe(409);
  const prepareCycle = (entry: number) =>
    prepareImported(
      new Request('http://localhost/api/imported-projects/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: projectId,
          revision: 1,
          wallet: f.wallet,
          walletRevision: 1,
          side: 'Buy',
          amount: '0.001',
          session: { sessionId, revision: 1, entry },
        }),
      }),
    );
  expect((await prepareCycle(2)).status).toBe(409);
  expect(mocks.prepare).not.toHaveBeenCalled();
  const prepared = await prepareCycle(1);
  expect(prepared.status).toBe(200);
  const data = (await prepared.json()) as {
    history: {
      id: string;
      document: { session: { notBefore: string; entry: number } };
    };
  };
  expect(data.history.document.session).toMatchObject({
    entry: 1,
    notBefore: input.schedule.startAt,
  });
  preparationId = data.history.id;
  // Preparation and approval share the real owner's balance-read gate.
  expect(
    (
      await post({
        action: 'review',
        preparationId,
        transaction: f.order.preparation.transaction,
      })
    ).status,
  ).toBe(429);
  await mocks.db
    .prepare(
      'UPDATE wallet_balance_gates SET next_allowed_at=0 WHERE owner_id=?',
    )
    .bind(owner)
    .run();
  const approval = await reviewed();
  expect(approval.session?.entry).toBe(1);
  expect(await count('imported_swap_signing_intents')).toBe(1);
  expect(
    mocks.rpc.mock.calls.some((call) => call[1] === 'sendTransaction'),
  ).toBe(false);
  expect(
    (
      await post({
        action: 'register',
        id: approval.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post({
        action: 'submit',
        id: approval.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(200);
  expect((await post({ action: 'recover', id: approval.id })).status).toBe(200);
  const history = await sessionGet(
    new Request(
      `http://localhost/api/imported-projects/trade-sessions?projectId=${projectId}`,
    ),
  );
  const state = (await history.json()) as {
    activity: { entry: number; state: string; receiptId: string }[];
  };
  expect(state.activity).toHaveLength(1);
  expect(state.activity[0]).toMatchObject({ entry: 1, state: 'finalized' });
  expect(state.activity[0].receiptId).toBeTruthy();
});
it('rejects mixed-wallet DCA and refuses saving when a database timing guard is missing', async () => {
  const input = dcaBody();
  expect(
    (await sessionPost(request({ ...input, entries: body().entries }))).status,
  ).toBe(400);
  const guard = await mocks.db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE name='trade_session_preparation_due'",
    )
    .first<{ sql: string }>();
  await mocks.db.prepare('DROP TRIGGER trade_session_preparation_due').run();
  try {
    expect((await sessionPost(request(input))).status).toBe(503);
    expect(await count('imported_trade_sessions')).toBe(0);
  } finally {
    await mocks.db.prepare(guard!.sql).run();
  }
});
async function captured() {
  await create();
  const guard = await captureTradeSession(
    mocks.db,
    owner,
    { sessionId, revision: 1, entry: 1 },
    {
      projectId,
      projectRevision: 1,
      wallet: f.wallet,
      walletRevision: 1,
      side: f.order.side,
      unitsRaw: f.order.inAmount,
      mint: f.mint,
      decimals: 6,
    },
  );
  await mocks.db
    .prepare(
      "UPDATE imported_swap_preparations SET document=json_set(document,'$.session',json(?)) WHERE owner_id=? AND id=?",
    )
    .bind(JSON.stringify(guard.selection), owner, preparationId)
    .run();
  return guard;
}
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
it('creates exact owned multi-wallet terms idempotently, rejects changed retries and retains immutable history', async () => {
  await create();
  expect((await sessionPost(request(body()))).status).toBe(200);
  expect((await sessionPost(request({ ...body(), side: 'Sell' }))).status).toBe(
    409,
  );
  expect(await count('imported_trade_sessions')).toBe(1);
  const page = await sessionGet(
    new Request(
      `http://localhost/api/imported-projects/trade-sessions?projectId=${projectId}`,
    ),
  );
  const data = (await page.json()) as {
    sessions: { terms: { totalRaw: string; entries: unknown[] } }[];
  };
  expect(data.sessions[0].terms.totalRaw).toBe('3000000');
  expect(data.sessions[0].terms.entries.length).toBe(2);
  await expect(
    mocks.db
      .prepare(
        "UPDATE imported_trade_sessions SET document='{}' WHERE owner_id=?",
      )
      .bind(owner)
      .run(),
  ).rejects.toThrow();
  await expect(
    mocks.db
      .prepare('DELETE FROM imported_trade_sessions WHERE owner_id=?')
      .bind(owner)
      .run(),
  ).rejects.toThrow();
});
it('rejects foreign wallets, duplicate entries and stale revisions without saving a session', async () => {
  const input = body();
  expect(
    (
      await sessionPost(
        request({
          ...input,
          entries: [{ ...input.entries[0], walletRevision: 2 }],
        }),
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await sessionPost(
        request({ ...input, entries: [input.entries[0], input.entries[0]] }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await sessionPost(request({ ...input, projectRevision: 2 }))).status,
  ).toBe(409);
  expect(await count('imported_trade_sessions')).toBe(0);
});
it('binds the actual preparation API to an exact session entry and rejects another amount before providers', async () => {
  await create();
  const prep = (amount: string) =>
    prepareImported(
      new Request('http://localhost/api/imported-projects/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: projectId,
          revision: 1,
          wallet: f.wallet,
          walletRevision: 1,
          side: 'Buy',
          amount,
          session: { sessionId, revision: 1, entry: 1 },
        }),
      }),
    );
  expect((await prep('0.002')).status).toBe(409);
  expect(mocks.prepare).not.toHaveBeenCalled();
  const response = await prep('0.001');
  expect(response.status).toBe(200);
  const data = (await response.json()) as {
    history: {
      document: {
        session: { sessionId: string; entry: number; unitsRaw: string };
      };
    };
  };
  expect(data.history.document.session).toMatchObject({
    sessionId,
    entry: 1,
    unitsRaw: '1000000',
  });
});
it('reviews and submits an exact session entry once, derives a finalized receipt, and leaves other wallets unapproved', async () => {
  const guard = await captured(),
    review = await reviewed();
  expect(review.session).toEqual(guard.selection);
  expect(
    (
      await sessionPost(
        request({ action: 'cancel', id: sessionId, projectId, revision: 1 }),
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await post({
        action: 'register',
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
  expect((await post({ action: 'recover', id: review.id })).status).toBe(200);
  const page = await sessionGet(
    new Request(
      `http://localhost/api/imported-projects/trade-sessions?projectId=${projectId}`,
    ),
  );
  const data = (await page.json()) as {
    activity: { entry: number; state: string; receiptId: string }[];
  };
  expect(data.activity).toHaveLength(1);
  expect(data.activity[0]).toMatchObject({ entry: 1, state: 'finalized' });
  expect(data.activity[0].receiptId).toBeTruthy();
  await expect(
    captureTradeSession(
      mocks.db,
      owner,
      { sessionId, revision: 1, entry: 1 },
      {
        projectId,
        projectRevision: 1,
        wallet: f.wallet,
        walletRevision: 1,
        side: 'Buy',
        unitsRaw: '1000000',
        mint: f.mint,
        decimals: 6,
      },
    ),
  ).rejects.toThrow('approved or filled');
  await expect(
    mocks.db
      .prepare('DELETE FROM imported_swap_receipts WHERE owner_id=?')
      .bind(owner)
      .run(),
  ).rejects.toThrow();
});
it('releases an unsigned cancelled approval but preserves the session and can cancel remaining entries', async () => {
  await captured();
  const review = await reviewed();
  expect((await post({ action: 'cancel', id: review.id })).status).toBe(200);
  expect(await count('solana_swap_reservations')).toBe(0);
  expect(
    (
      await sessionPost(
        request({ action: 'cancel', id: sessionId, projectId, revision: 1 }),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await post({
        action: 'review',
        preparationId,
        transaction: f.order.preparation.transaction,
      })
    ).status,
  ).toBe(409);
});
it('recovers a registered session entry across project and wallet archival while retaining its capture', async () => {
  await captured();
  const review = await reviewed();
  expect(
    (
      await post({
        action: 'register',
        id: review.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(200);
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
  expect(
    (
      await post({
        action: 'submit',
        id: review.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(409);
  expect((await post({ action: 'recover', id: review.id })).status).toBe(200);
  expect(await count('solana_swap_reservations')).toBe(0);
});
it('rolls back a stripped session approval and its shared wallet reservation', async () => {
  await captured();
  const review = await reviewed();
  expect((await post({ action: 'cancel', id: review.id })).status).toBe(200);
  const wrong = { ...review, id: crypto.randomUUID(), session: undefined };
  await expect(
    mocks.db
      .prepare(
        "INSERT INTO imported_swap_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,created_at,updated_at) VALUES(?,?,?,?,?,'awaiting_signature',?,?)",
      )
      .bind(
        wrong.id,
        owner,
        preparationId,
        f.wallet,
        JSON.stringify(wrong),
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run(),
  ).rejects.toThrow();
  expect(await count('solana_swap_reservations')).toBe(0);
});

it('finalizes an exact Sell session entry using token precision and verified sell receipt units', async () => {
  f = await nativeWarmupFixture({ side: 'Sell', lookup: true, v2: true });
  mocks.simulate.mockResolvedValue(f.simulation);
  const document = {
    ...unsignedPreparationSummary(f.order, f.simulation),
    balance: {
      source: 'fixture.test',
      observedAt: new Date().toISOString(),
      requestedRaw: '1000',
      amountCovered: true,
    },
  };
  await mocks.db
    .prepare(
      'UPDATE imported_swap_preparations SET document=? WHERE owner_id=? AND id=?',
    )
    .bind(JSON.stringify(document), owner, preparationId)
    .run();
  const guard = await captured();
  expect(guard.selection.unitsRaw).toBe('1000');
  const review = await reviewed();
  expect(
    (
      await post({
        action: 'register',
        id: review.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(200);
  expect((await post({ action: 'recover', id: review.id })).status).toBe(200);
  expect(await count('solana_swap_reservations')).toBe(0);
});

it('retains the exact save, review, cancellation and session cancellation timeline without duplicate save events', async () => {
  await captured();
  await create();
  const review = await reviewed();
  await post({ action: 'cancel', id: review.id });
  expect(
    (
      await sessionPost(
        request({ action: 'cancel', id: sessionId, projectId, revision: 1 }),
      )
    ).status,
  ).toBe(200);
  const response = await sessionEvents(
    new Request(
      `http://localhost/api/imported-projects/session-events?projectId=${projectId}&sessionId=${sessionId}`,
    ),
  );
  expect(response.status).toBe(200);
  const data = (await response.json()) as {
    events: import('@/lib/imported-trade-session-events').TradeSessionEvent[];
    nextCursor: string | null;
  };
  expect(data.events.map((e) => e.type)).toEqual([
    'session.cancelled',
    'approval.cancelled',
    'approval.reviewed',
    'session.saved',
  ]);
  expect(data.events[0].document.state).toBe('cancelled');
  expect(data.events[0].document.revision).toBe(2);
  expect(data.events[1].document.state).toBe('active');
  expect(data.events[1].approval!.id).toBe(review.id);
  expect(data.events[1].approval!.sha256).toBe(review.sha256);
  expect(data.events[1].approval!.signature).toBeNull();
  expect(data.events[1].document.terms.entries[0].unitsRaw).toBe(
    f.order.inAmount,
  );
  await expect(
    mocks.db
      .prepare('DELETE FROM imported_trade_session_events WHERE owner_id=?')
      .bind(owner)
      .run(),
  ).rejects.toThrow(/retained/);
  await expect(
    mocks.db
      .prepare(
        "UPDATE imported_trade_session_events SET type='session.baseline' WHERE owner_id=?",
      )
      .bind(owner)
      .run(),
  ).rejects.toThrow(/immutable/);
});
it('rolls back a session and its approval reservation if event persistence fails', async () => {
  await mocks.db
    .prepare(
      "CREATE TRIGGER fail_session_history BEFORE INSERT ON imported_trade_session_events BEGIN SELECT RAISE(ABORT,'fixture history failure'); END",
    )
    .run();
  try {
    expect((await sessionPost(request(body()))).status).toBe(503);
    expect(await count('imported_trade_sessions')).toBe(0);
  } finally {
    await mocks.db.prepare('DROP TRIGGER fail_session_history').run();
  }
  await captured();
  await mocks.db
    .prepare(
      "CREATE TRIGGER fail_session_history BEFORE INSERT ON imported_trade_session_events WHEN NEW.approval IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture history failure'); END",
    )
    .run();
  try {
    expect(
      (
        await post({
          action: 'review',
          preparationId,
          transaction: f.order.preparation.transaction,
        })
      ).ok,
    ).toBe(false);
    expect(await count('imported_swap_signing_intents')).toBe(0);
    expect(await count('solana_swap_reservations')).toBe(0);
  } finally {
    await mocks.db.prepare('DROP TRIGGER fail_session_history').run();
  }
});
it('enforces owned context for account, project, session and cursor history across archival', async () => {
  await create();
  const response = await sessionEvents(
    new Request('http://localhost/api/imported-projects/session-events'),
  );
  const data = (await response.json()) as {
    events: import('@/lib/imported-trade-session-events').TradeSessionEvent[];
    nextCursor: string | null;
  };
  expect(data.events).toHaveLength(1);
  const id = data.events[0].id;
  expect(
    (
      await sessionEvents(
        new Request(
          `http://localhost/api/imported-projects/session-events?cursor=${id}`,
        ),
      )
    ).status,
  ).toBe(200);
  await mocks.db
    .prepare('UPDATE imported_token_projects SET archived=1 WHERE owner_id=?')
    .bind(owner)
    .run();
  expect(
    (
      await sessionEvents(
        new Request(
          `http://localhost/api/imported-projects/session-events?projectId=${projectId}&sessionId=${sessionId}`,
        ),
      )
    ).status,
  ).toBe(200);
  mocks.user = { userId: 'foreign' };
  expect(
    (
      await sessionEvents(
        new Request(
          `http://localhost/api/imported-projects/session-events?cursor=${id}`,
        ),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await sessionEvents(
        new Request(
          `http://localhost/api/imported-projects/session-events?projectId=${projectId}`,
        ),
      )
    ).status,
  ).toBe(404);
  const foreign = (await (
    await sessionEvents(
      new Request('http://localhost/api/imported-projects/session-events'),
    )
  ).json()) as { events: unknown[] };
  expect(foreign.events).toEqual([]);
  mocks.user = null;
  expect(
    (
      await sessionEvents(
        new Request('http://localhost/api/imported-projects/session-events'),
      )
    ).status,
  ).toBe(401);
});
it('paginates 51 captured events by owned sequence without repeating a boundary', async () => {
  for (let i = 0; i < 51; i++) {
    sessionId = crypto.randomUUID();
    await create();
  }
  const first = (await (
    await sessionEvents(
      new Request('http://localhost/api/imported-projects/session-events'),
    )
  ).json()) as {
    events: import('@/lib/imported-trade-session-events').TradeSessionEvent[];
    nextCursor: string | null;
  };
  expect(first.events).toHaveLength(50);
  expect(first.nextCursor).toBe(first.events.at(-1)!.id);
  const second = (await (
    await sessionEvents(
      new Request(
        `http://localhost/api/imported-projects/session-events?cursor=${first.nextCursor}`,
      ),
    )
  ).json()) as {
    events: import('@/lib/imported-trade-session-events').TradeSessionEvent[];
    nextCursor: string | null;
  };
  expect(second.events).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(second.events[0].sequence).toBeLessThan(first.events.at(-1)!.sequence);
}, 30000);

it('captures the signature, submission and exact receipt once through finalized recovery', async () => {
  await captured();
  const review = await reviewed();
  expect(
    (
      await post({
        action: 'register',
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
  ).toBe(200);
  expect((await post({ action: 'recover', id: review.id })).status).toBe(200);
  expect((await post({ action: 'recover', id: review.id })).status).toBe(200);
  const data = (await (
    await sessionEvents(
      new Request(
        `http://localhost/api/imported-projects/session-events?projectId=${projectId}&sessionId=${sessionId}`,
      ),
    )
  ).json()) as {
    events: import('@/lib/imported-trade-session-events').TradeSessionEvent[];
  };
  expect(data.events.map((e) => e.type)).toEqual([
    'approval.finalized',
    'approval.submission_started',
    'approval.signed',
    'approval.reviewed',
    'session.saved',
  ]);
  expect(data.events[0].approval?.signature).toBe(f.signed.signature);
  expect(data.events[0].approval?.receiptId).toMatch(/^[a-f0-9-]{36}$/);
  expect(data.events[1].approval?.receiptId).toBeNull();
});

async function scheduledSession(startAt: string, spacingSeconds = 30) {
  const response = await sessionPost(
    request({ ...body(), schedule: { startAt, spacingSeconds } }),
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    session: import('@/lib/imported-trade-session').TradeSession;
  }>;
}
async function retainedScheduledCapture(startAt: string) {
  const { session } = await scheduledSession(startAt),
    bytes = new TextEncoder().encode(JSON.stringify(session.terms)),
    hash = await crypto.subtle.digest('SHA-256', bytes);
  const capture = {
    format: 'trade-session-entry-v2',
    notBefore: startAt,
    sessionId,
    sessionRevision: 1,
    entry: 1,
    unitsRaw: f.order.inAmount,
    termsSha256: Array.from(new Uint8Array(hash), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join(''),
  };
  await mocks.db
    .prepare(
      "UPDATE imported_swap_preparations SET document=json_set(document,'$.session',json(?)) WHERE owner_id=? AND id=?",
    )
    .bind(JSON.stringify(capture), owner, preparationId)
    .run();
  return capture;
}
it('retains a scheduled start and spacing across retries and rejects invalid new schedule horizons', async () => {
  const startAt = new Date(Date.now() + 60000).toISOString(),
    first = await scheduledSession(startAt);
  expect(first.session.terms.schedule).toEqual({ startAt, spacingSeconds: 30 });
  expect(first.session.terms.format).toBe('imported-trade-session-v2');
  expect(await scheduledSession(startAt)).toEqual(first);
  expect(
    (
      await sessionPost(
        request({ ...body(), schedule: { startAt, spacingSeconds: 31 } }),
      )
    ).status,
  ).toBe(409);
  sessionId = crypto.randomUUID();
  expect(
    (
      await sessionPost(
        request({
          ...body(),
          schedule: {
            startAt: new Date(Date.now() - 120000).toISOString(),
            spacingSeconds: 30,
          },
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await sessionPost(
        request({
          ...body(),
          schedule: {
            startAt: new Date(Date.now() + 366 * 86400000).toISOString(),
            spacingSeconds: 30,
          },
        }),
      )
    ).status,
  ).toBe(400);
});
it('rejects early preparation and review before balance, quote and simulation providers', async () => {
  const startAt = new Date(Date.now() + 60000).toISOString();
  await retainedScheduledCapture(startAt);
  const prep = await prepareImported(
    new Request('http://localhost/api/imported-projects/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        revision: 1,
        wallet: f.wallet,
        walletRevision: 1,
        side: 'Buy',
        amount: '0.001',
        session: { sessionId, revision: 1, entry: 1 },
      }),
    }),
  );
  expect(prep.status).toBe(409);
  expect(await prep.json()).toMatchObject({
    error: 'Trade session entry is not due yet.',
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
  expect(mocks.balance).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.simulate).not.toHaveBeenCalled();
  expect(await count('imported_swap_signing_intents')).toBe(0);
});
it('checks immutable due time in actual preparation and approval SQL rather than trusting altered client times', async () => {
  const c = await retainedScheduledCapture(
    new Date(Date.now() + 60000).toISOString(),
  );
  for (const capture of [
    c,
    { ...c, notBefore: new Date(Date.now() - 60000).toISOString() },
    { ...c, format: 'trade-session-entry-v1', notBefore: undefined },
  ]) {
    await expect(
      mocks.db
        .prepare(
          "INSERT INTO imported_swap_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,created_at,updated_at) VALUES(?,?,?,?,?,'awaiting_signature',?,?)",
        )
        .bind(
          crypto.randomUUID(),
          owner,
          preparationId,
          f.wallet,
          JSON.stringify({ session: capture }),
          new Date().toISOString(),
          new Date().toISOString(),
        )
        .run(),
    ).rejects.toThrow(/timing differs or entry is not due/);
    const source = await mocks.db
      .prepare(
        'SELECT document FROM imported_swap_preparations WHERE owner_id=? AND id=?',
      )
      .bind(owner, preparationId)
      .first<{ document: string }>();
    const doc = { ...JSON.parse(source!.document), session: capture };
    await expect(
      mocks.db
        .prepare(
          'INSERT INTO imported_swap_preparations(owner_id,id,project_id,project_revision,wallet_revision,wallet_address,document,created_at) SELECT owner_id,?,project_id,project_revision,wallet_revision,wallet_address,?,created_at FROM imported_swap_preparations WHERE owner_id=? AND id=?',
        )
        .bind(crypto.randomUUID(), JSON.stringify(doc), owner, preparationId)
        .run(),
    ).rejects.toThrow(/timing differs or entry is not due/);
  }
  expect(await count('imported_swap_signing_intents')).toBe(0);
  expect(await count('solana_swap_reservations')).toBe(0);
});
it('reviews, separately submits and recovers a due scheduled entry with its original captured timestamp', async () => {
  const startAt = new Date(Date.now() - 1000).toISOString();
  const capture = await retainedScheduledCapture(startAt),
    review = await reviewed();
  expect(review.session).toEqual(capture);
  expect(
    (
      await post({
        action: 'register',
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
  ).toBe(200);
  expect((await post({ action: 'recover', id: review.id })).status).toBe(200);
  const page = (await (
    await sessionEvents(
      new Request(
        `http://localhost/api/imported-projects/session-events?projectId=${projectId}`,
      ),
    )
  ).json()) as {
    events: import('@/lib/imported-trade-session-events').TradeSessionEvent[];
  };
  expect(page.events[0].document.terms.schedule?.startAt).toBe(startAt);
  expect(page.events[0].type).toBe('approval.finalized');
});

it('keeps the final SQL timing guard closed even when the application clock is ahead', async () => {
  const now = Date.now(),
    startAt = new Date(now + 60000).toISOString();
  await retainedScheduledCapture(startAt);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 120000);
  let guard;
  try {
    guard = await captureTradeSession(
      mocks.db,
      owner,
      { sessionId, revision: 1, entry: 1 },
      {
        projectId,
        projectRevision: 1,
        wallet: f.wallet,
        walletRevision: 1,
        side: 'Buy',
        unitsRaw: f.order.inAmount,
        mint: f.mint,
        decimals: 6,
      },
    );
  } finally {
    clock.mockRestore();
  }
  const write = tradeSessionWriteGuard(owner, guard),
    result = await mocks.db
      .prepare(
        "UPDATE imported_trade_sessions SET state='cancelled',revision=revision+1,updated_at=? WHERE owner_id=? AND id=?" +
          write.sql,
      )
      .bind(new Date().toISOString(), owner, sessionId, ...write.bindings)
      .run();
  expect(result.meta.changes).toBe(0);
  const row = await mocks.db
    .prepare(
      'SELECT state FROM imported_trade_sessions WHERE owner_id=? AND id=?',
    )
    .bind(owner, sessionId)
    .first<{ state: string }>();
  expect(row?.state).toBe('active');
});

const controlRequest = (action: 'pause' | 'resume', revision: number) =>
  sessionPost(request({ action, id: sessionId, projectId, revision }));
async function controlRow() {
  return mocks.db
    .prepare(
      'SELECT state,revision FROM imported_trade_session_controls WHERE owner_id=? AND session_id=?',
    )
    .bind(owner, sessionId)
    .first<{ state: string; revision: number }>();
}
it('preserves historical event identity, sequence and captured documents when migrating retained sessions to controls', async () => {
  expect(
    await mocks.db
      .prepare(
        'SELECT sequence,id,owner_id,project_id,session_id,type,document,approval,created_at FROM imported_trade_session_events WHERE owner_id=?',
      )
      .bind('legacy-control-fixture')
      .first(),
  ).toEqual(oldMigrationEvent);
  expect(
    await mocks.db
      .prepare(
        'SELECT state,revision FROM imported_trade_session_controls WHERE owner_id=? AND session_id=?',
      )
      .bind('legacy-control-fixture', legacySessionId)
      .first(),
  ).toEqual({ state: 'ready', revision: 1 });
});
it('persists pause and resume with independent revisions, idempotent retries and exact captured control history', async () => {
  await create();
  expect(await controlRow()).toEqual({ state: 'ready', revision: 1 });
  expect((await controlRequest('pause', 1)).status).toBe(200);
  expect((await controlRequest('pause', 1)).status).toBe(200);
  expect(await controlRow()).toEqual({ state: 'paused', revision: 2 });
  expect((await controlRequest('resume', 1)).status).toBe(409);
  expect((await controlRequest('resume', 2)).status).toBe(200);
  expect((await controlRequest('resume', 2)).status).toBe(200);
  expect(await controlRow()).toEqual({ state: 'ready', revision: 3 });
  const data = (await (
    await sessionEvents(
      new Request(
        `http://localhost/api/imported-projects/session-events?projectId=${projectId}&sessionId=${sessionId}`,
      ),
    )
  ).json()) as {
    events: import('@/lib/imported-trade-session-events').TradeSessionEvent[];
  };
  expect(data.events.map((e) => e.type)).toEqual([
    'session.resumed',
    'session.paused',
    'session.saved',
  ]);
  expect(data.events[0].control?.revision).toBe(3);
  expect(data.events[1].control?.state).toBe('paused');
  expect(data.events[1].document.revision).toBe(1);
  await expect(
    mocks.db
      .prepare('DELETE FROM imported_trade_session_controls WHERE owner_id=?')
      .bind(owner)
      .run(),
  ).rejects.toThrow(/retained/);
  await expect(
    mocks.db
      .prepare(
        "UPDATE imported_trade_session_controls SET state='paused',revision=8 WHERE owner_id=?",
      )
      .bind(owner)
      .run(),
  ).rejects.toThrow(/context differs/);
});
it('blocks paused preparation and review before provider calls, then permits a fresh review after resume', async () => {
  await captured();
  await controlRequest('pause', 1);
  const prep = await prepareImported(
    new Request('http://localhost/api/imported-projects/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        revision: 1,
        wallet: f.wallet,
        walletRevision: 1,
        side: 'Buy',
        amount: '0.001',
        session: { sessionId, revision: 1, entry: 1 },
      }),
    }),
  );
  expect(prep.status).toBe(409);
  expect(
    (
      await post({
        action: 'review',
        preparationId,
        transaction: f.order.preparation.transaction,
      })
    ).status,
  ).toBe(409);
  expect(mocks.balance).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.simulate).not.toHaveBeenCalled();
  expect(await count('imported_swap_signing_intents')).toBe(0);
  await controlRequest('resume', 2);
  expect((await reviewed()).session?.sessionId).toBe(sessionId);
});
it('retains registered signatures and finalized recovery while paused but refuses any broadcast', async () => {
  await captured();
  const review = await reviewed();
  expect(
    (
      await post({
        action: 'register',
        id: review.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(200);
  await controlRequest('pause', 1);
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
  ).toHaveLength(0);
  expect((await post({ action: 'recover', id: review.id })).status).toBe(200);
  expect(await controlRow()).toEqual({ state: 'paused', revision: 2 });
  const row = await mocks.db
    .prepare(
      'SELECT state,signature FROM imported_swap_signing_intents WHERE owner_id=? AND id=?',
    )
    .bind(owner, review.id)
    .first();
  expect(row).toEqual({ state: 'finalized', signature: f.signed.signature });
  expect(await count('solana_swap_reservations')).toBe(0);
});
it('rejects a pause during simulation and a pause-resume cycle between the final read and guarded write', async () => {
  const guard = await captured();
  mocks.simulate.mockImplementationOnce(async () => {
    await controlRequest('pause', 1);
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
  expect(await count('imported_swap_signing_intents')).toBe(0);
  await controlRequest('resume', 2);
  const write = tradeSessionWriteGuard(owner, guard),
    result = await mocks.db
      .prepare(
        "UPDATE imported_trade_sessions SET state='cancelled',revision=revision+1,updated_at=? WHERE owner_id=? AND id=?" +
          write.sql,
      )
      .bind(new Date().toISOString(), owner, sessionId, ...write.bindings)
      .run();
  expect(result.meta.changes).toBe(0);
});
it('rolls back control state when captured-event persistence fails and rejects foreign or cancelled control actions', async () => {
  await create();
  await mocks.db
    .prepare(
      "CREATE TRIGGER fail_control_history BEFORE INSERT ON imported_trade_session_events WHEN NEW.type='session.paused' BEGIN SELECT RAISE(ABORT,'fixture control event failure'); END",
    )
    .run();
  try {
    expect((await controlRequest('pause', 1)).status).toBe(503);
    expect(await controlRow()).toEqual({ state: 'ready', revision: 1 });
  } finally {
    await mocks.db.prepare('DROP TRIGGER fail_control_history').run();
  }
  mocks.user = { userId: 'foreign' };
  expect((await controlRequest('pause', 1)).status).toBe(409);
  mocks.user = { userId: owner };
  await sessionPost(
    request({ action: 'cancel', id: sessionId, projectId, revision: 1 }),
  );
  expect((await controlRequest('pause', 1)).status).toBe(409);
  mocks.user = null;
  expect((await controlRequest('pause', 1)).status).toBe(401);
});

it('registers an already-created exact signature while paused so it can be recovered without broadcast', async () => {
  await captured();
  const review = await reviewed();
  await controlRequest('pause', 1);
  expect(
    (
      await post({
        action: 'register',
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
  ).toHaveLength(0);
  expect((await post({ action: 'recover', id: review.id })).status).toBe(200);
});

it('reads only an exact owned project approval across pause and archive, rejecting foreign IDs and mixed cursors', async () => {
  await captured();
  const review = await reviewed();
  const read = (id = review.id, extra = '') =>
    approvalGet(
      new Request(
        `http://localhost/api/imported-projects/signing?projectId=${projectId}&intentId=${id}${extra}`,
      ),
    );
  const response = await read();
  expect(response.status).toBe(200);
  const page = (await response.json()) as {
    intents: { id: string; document: { session: { sessionId: string } } }[];
    nextCursor: null;
  };
  expect(page.intents.map((r) => r.id)).toEqual([review.id]);
  expect(page.intents[0].document.session.sessionId).toBe(sessionId);
  expect(page.nextCursor).toBeNull();
  expect((await read(crypto.randomUUID())).status).toBe(404);
  expect((await read('invalid')).status).toBe(400);
  expect((await read(review.id, `&cursor=${review.id}`)).status).toBe(400);
  await sessionPost(
    request({ action: 'pause', projectId, id: sessionId, revision: 1 }),
  );
  await mocks.db
    .prepare(
      'UPDATE imported_token_projects SET archived=1,revision=2 WHERE owner_id=?',
    )
    .bind(owner)
    .run();
  expect((await read()).status).toBe(200);
  mocks.user = { userId: 'foreign' };
  expect((await read()).status).toBe(404);
  mocks.user = null;
  expect((await read()).status).toBe(401);
});

const jobScope = () => ({ owner, projectId, sessionId });
async function queueJob(entry = 1, id = crypto.randomUUID()) {
  const response = await jobPost(
    request({ action: 'queue', id, projectId, sessionId, entry }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    job: import('@/lib/session-preparation-jobs').SessionPreparationJob;
  };
}
const jobsRead = (id?: string) =>
  jobGet(
    new Request(
      `http://localhost/api/imported-projects/session-preparation-jobs?projectId=${projectId}&sessionId=${sessionId}${id ? '&jobId=' + id : ''}`,
    ),
  );
it('queues exact owned unsigned jobs idempotently and retains jobs/events without exposing packets or leases in lists', async () => {
  await create();
  const { job } = await queueJob();
  expect((await queueJob(1, job.id)).job.id).toBe(job.id);
  expect(
    (
      await jobPost(
        request({
          action: 'queue',
          id: crypto.randomUUID(),
          projectId,
          sessionId,
          entry: 1,
        }),
      )
    ).status,
  ).toBe(409);
  const list = await jobsRead();
  expect(list.status).toBe(200);
  const data = (await list.json()) as { jobs: unknown[] };
  expect(data.jobs).toHaveLength(1);
  expect(JSON.stringify(data)).not.toContain('leaseToken');
  expect(JSON.stringify(data)).not.toContain('payload');
  expect((await jobsRead(job.id)).status).toBe(409);
  await expect(
    mocks.db
      .prepare('DELETE FROM session_preparation_jobs WHERE owner_id=?')
      .bind(owner)
      .run(),
  ).rejects.toThrow();
  await expect(
    mocks.db
      .prepare(
        "UPDATE session_preparation_job_events SET document='{}' WHERE owner_id=?",
      )
      .bind(owner)
      .run(),
  ).rejects.toThrow();
  mocks.user = { userId: 'foreign' };
  expect((await jobsRead()).status).toBe(404);
  mocks.user = null;
  expect((await jobsRead()).status).toBe(401);
});
it('withholds future and paused unsigned jobs before provider calls and resumes exact due preparation into a retained packet', async () => {
  const scheduled = {
    ...body(),
    schedule: {
      startAt: new Date(Date.now() + 60000).toISOString(),
      spacingSeconds: 30,
    },
  };
  expect((await sessionPost(request(scheduled))).status).toBe(200);
  const { job } = await queueJob();
  const service = vi.fn(prepareOwnedImportedSwap);
  expect(
    (await runSessionPreparationJobs(mocks.db, service, jobScope(), 1))
      .processed,
  ).toBe(0);
  expect(service).not.toHaveBeenCalled();
  await sessionPost(
    request({ action: 'pause', id: sessionId, projectId, revision: 1 }),
  );
  expect(
    (await runSessionPreparationJobs(mocks.db, service, jobScope(), 1))
      .processed,
  ).toBe(0);
  expect(mocks.balance).not.toHaveBeenCalled();
  expect(
    (
      await jobPost(
        request({
          action: 'queue',
          id: crypto.randomUUID(),
          projectId,
          sessionId,
          entry: 2,
        }),
      )
    ).status,
  ).toBe(409);
  expect((await jobsRead(job.id)).status).toBe(409);
});
it('prepares a due unsigned job once, restores only its owned current unexpired packet, and requires a separate signing review', async () => {
  await create();
  const { job } = await queueJob();
  const result = await jobPost(
    request({ action: 'runDue', projectId, sessionId }),
  );
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    processed: 1,
    executionAllowed: false,
  });
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  const packet = await jobsRead(job.id);
  expect(packet.status).toBe(200);
  const value = (await packet.json()) as {
    history: { id: string; document: { session: { sessionId: string } } };
    order: { preparation: { transaction: string } };
  };
  expect(value.history.document.session.sessionId).toBe(sessionId);
  expect(value.order.preparation.transaction).toBe(
    f.order.preparation.transaction,
  );
  const savedSession = (
    (await (
      await sessionGet(
        new Request(
          `http://localhost/api/imported-projects/trade-sessions?projectId=${projectId}`,
        ),
      )
    ).json()) as { sessions: unknown[] }
  ).sessions[0];
  await mkdir(new URL('../../../../work/trade-session-qa/', import.meta.url), {
    recursive: true,
  });
  await writeFile(
    new URL(
      '../../../../work/trade-session-qa/job-packet.json',
      import.meta.url,
    ),
    JSON.stringify({ payload: value, session: savedSession }),
    'utf8',
  );
  expect(await count('imported_swap_signing_intents')).toBe(0);
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(
    (
      await post({
        action: 'review',
        preparationId: value.history.id,
        transaction: value.order.preparation.transaction,
      })
    ).status,
  ).toBe(429);
  await mocks.db
    .prepare(
      'UPDATE wallet_balance_gates SET next_allowed_at=0 WHERE owner_id=?',
    )
    .bind(owner)
    .run();
  expect(
    (
      await post({
        action: 'review',
        preparationId: value.history.id,
        transaction: value.order.preparation.transaction,
      })
    ).status,
  ).toBe(200);
  expect((await jobsRead(job.id)).status).toBe(503);
  expect(mocks.rpc.mock.calls.some((c) => c[1] === 'sendTransaction')).toBe(
    false,
  );
});
it('resumes paused queued work and rejects packet review after a subsequent pause or archival', async () => {
  await create();
  const { job } = await queueJob();
  await sessionPost(
    request({ action: 'pause', id: sessionId, projectId, revision: 1 }),
  );
  expect(
    (
      await runSessionPreparationJobs(
        mocks.db,
        prepareOwnedImportedSwap,
        jobScope(),
        1,
      )
    ).processed,
  ).toBe(0);
  await sessionPost(
    request({ action: 'resume', id: sessionId, projectId, revision: 2 }),
  );
  expect(
    (
      await runSessionPreparationJobs(
        mocks.db,
        prepareOwnedImportedSwap,
        jobScope(),
        1,
      )
    ).processed,
  ).toBe(1);
  expect((await jobsRead(job.id)).status).toBe(200);
  await sessionPost(
    request({ action: 'pause', id: sessionId, projectId, revision: 3 }),
  );
  expect((await jobsRead(job.id)).status).toBe(503);
  await mocks.db
    .prepare('UPDATE imported_token_projects SET archived=1 WHERE owner_id=?')
    .bind(owner)
    .run();
  expect((await jobsRead()).status).toBe(200);
});
it('bounds transient retries at three attempts with retained error events and prevents overlapping owner leases', async () => {
  await create();
  const { job } = await queueJob();
  let release!: (r: Response) => void;
  const service = vi.fn(
    () =>
      new Promise<Response>((r) => {
        release = r;
      }),
  );
  const first = runSessionPreparationJobs(mocks.db, service, jobScope(), 1);
  while (!release) await new Promise((r) => setTimeout(r, 10));
  expect(
    (await runSessionPreparationJobs(mocks.db, service, jobScope(), 1))
      .processed,
  ).toBe(0);
  expect(service).toHaveBeenCalledTimes(1);
  release(Response.json({ error: 'provider private detail' }, { status: 429 }));
  await first;
  for (let i = 0; i < 2; i++) {
    await mocks.db
      .prepare(
        "UPDATE session_preparation_jobs SET next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=? AND id=?",
      )
      .bind(owner, job.id)
      .run();
    await runSessionPreparationJobs(
      mocks.db,
      async () => Response.json({}, { status: 502 }),
      jobScope(),
      1,
    );
  }
  const data = (await (await jobsRead()).json()) as {
    jobs: { state: string; attempts: number; lastError: string }[];
  };
  expect(data.jobs[0]).toMatchObject({
    state: 'failed',
    attempts: 3,
    lastError: 'service-unavailable',
  });
  expect(JSON.stringify(data)).not.toContain('provider private detail');
  expect(
    (await runSessionPreparationJobs(mocks.db, service, jobScope(), 1))
      .processed,
  ).toBe(0);
  expect(await count('session_preparation_job_events')).toBeGreaterThanOrEqual(
    7,
  );
});
it('cancels queued work when parent context is cancelled', async () => {
  await create();
  const { job } = await queueJob();
  await sessionPost(
    request({ action: 'cancel', id: sessionId, projectId, revision: 1 }),
  );
  const service = vi.fn(prepareOwnedImportedSwap);
  expect(
    (await runSessionPreparationJobs(mocks.db, service, jobScope(), 1))
      .processed,
  ).toBe(0);
  expect(service).not.toHaveBeenCalled();
  const data = (await (await jobsRead()).json()) as {
    jobs: { state: string }[];
  };
  expect(data.jobs[0].state).toBe('cancelled');
  expect((await jobsRead(job.id)).status).toBe(409);
});

it('rejects expired queued packets without provider calls or wallet signing', async () => {
  await create();
  const { job } = await queueJob();
  await runSessionPreparationJobs(
    mocks.db,
    prepareOwnedImportedSwap,
    jobScope(),
    1,
  );
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120000);
  try {
    expect((await jobsRead(job.id)).status).toBe(410);
  } finally {
    now.mockRestore();
  }
  expect(await count('imported_swap_signing_intents')).toBe(0);
});
it('rolls back queue writes when captured event persistence fails and rejects incomplete result payloads', async () => {
  await captured();
  await mocks.db
    .prepare(
      `CREATE TRIGGER fail_job_event_${owner.replaceAll('-', '')} BEFORE INSERT ON session_preparation_job_events WHEN NEW.owner_id='${owner}' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`,
    )
    .run();
  expect(
    (
      await jobPost(
        request({
          action: 'queue',
          id: crypto.randomUUID(),
          projectId,
          sessionId,
          entry: 1,
        }),
      )
    ).status,
  ).toBe(409);
  expect(await count('session_preparation_jobs')).toBe(0);
  await mocks.db
    .prepare(`DROP TRIGGER fail_job_event_${owner.replaceAll('-', '')}`)
    .run();
  const { job } = await queueJob();
  await runSessionPreparationJobs(
    mocks.db,
    async () =>
      Response.json({
        history: { id: preparationId },
        order: { executionAllowed: false },
      }),
    jobScope(),
    1,
  );
  const data = (await (await jobsRead()).json()) as {
    jobs: { state: string; lastError: string }[];
  };
  expect(data.jobs[0]).toMatchObject({
    state: 'queued',
    lastError: 'service-unavailable',
  });
  expect((await jobsRead(job.id)).status).toBe(409);
});
it('recovers an expired worker lease and ignores its late completion without persisting its packet', async () => {
  await captured();
  const { job } = await queueJob();
  let release!: (value: Response) => void;
  const first = runSessionPreparationJobs(
    mocks.db,
    () =>
      new Promise<Response>((r) => {
        release = r;
      }),
    jobScope(),
    1,
  );
  while (!release) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 45500));
  expect(
    (
      await runSessionPreparationJobs(
        mocks.db,
        async () => Response.json({}, { status: 502 }),
        jobScope(),
        1,
      )
    ).processed,
  ).toBe(0);
  release(Response.json({ history: { id: preparationId } }));
  await first;
  const data = (await (await jobsRead()).json()) as {
    jobs: { state: string; attempts: number; lastError: string }[];
  };
  expect(data.jobs[0]).toMatchObject({
    state: 'queued',
    attempts: 1,
    lastError: 'lease-expired',
  });
  expect((await jobsRead(job.id)).status).toBe(409);
}, 65000);

it('reads captured job transitions with owned scope and archival access', async () => {
  await create();
  const { job } = await queueJob();
  await mocks.db
    .prepare(
      "UPDATE session_preparation_jobs SET state='cancelled',last_error='context-changed' WHERE owner_id=? AND id=?",
    )
    .bind(owner, job.id)
    .run();
  const url = `http://localhost/api/imported-projects/session-job-events?projectId=${projectId}&sessionId=${sessionId}`;
  const page = (await (await jobEvents(new Request(url))).json()) as {
    events: { id: string; document: { state: string } }[];
    nextCursor: null;
  };
  expect(page.events.map((e) => e.document.state)).toEqual([
    'cancelled',
    'queued',
  ]);
  expect(page.nextCursor).toBeNull();
  expect(JSON.stringify(page)).not.toContain('lease_token');
  expect((await jobEvents(new Request(url + '&cursor=invalid'))).status).toBe(
    400,
  );
  expect(
    (await jobEvents(new Request(url + '&cursor=' + 'f'.repeat(32)))).status,
  ).toBe(400);
  mocks.user = { userId: 'foreign' };
  expect((await jobEvents(new Request(url))).status).toBe(404);
  const foreign = (await (
    await jobEvents(
      new Request('http://localhost/api/imported-projects/session-job-events'),
    )
  ).json()) as { events: unknown[] };
  expect(foreign.events).toEqual([]);
  expect(
    (
      await jobEvents(
        new Request(
          'http://localhost/api/imported-projects/session-job-events?cursor=' +
            page.events[0].id,
        ),
      )
    ).status,
  ).toBe(400);
  mocks.user = null;
  expect((await jobEvents(new Request(url))).status).toBe(401);
  mocks.user = { userId: owner };
  await mocks.db
    .prepare(
      'UPDATE imported_token_projects SET archived=1,revision=2 WHERE owner_id=?',
    )
    .bind(owner)
    .run();
  expect((await jobEvents(new Request(url))).status).toBe(200);
  expect(
    (
      await jobEvents(
        new Request(
          `http://localhost/api/imported-projects/session-job-events?sessionId=${sessionId}`,
        ),
      )
    ).status,
  ).toBe(400);
});
it('paginates 51 retained job events without overlap and rejects malformed captures', async () => {
  await create();
  const { job } = await queueJob();
  const doc = JSON.stringify({
    id: job.id,
    entry: 1,
    state: 'queued',
    attempts: 0,
    preparationId: null,
    error: null,
  });
  const insert = () =>
    mocks.db
      .prepare(
        'INSERT INTO session_preparation_job_events(id,owner_id,project_id,session_id,job_id,document,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .bind(
        crypto.randomUUID().replaceAll('-', ''),
        owner,
        projectId,
        sessionId,
        job.id,
        doc,
        new Date().toISOString(),
      );
  await mocks.db.batch(Array.from({ length: 50 }, insert));
  const url = `http://localhost/api/imported-projects/session-job-events?projectId=${projectId}&sessionId=${sessionId}`;
  const first = (await (await jobEvents(new Request(url))).json()) as {
    events: { id: string }[];
    nextCursor: string;
  };
  expect(first.events).toHaveLength(50);
  expect(first.nextCursor).toBe(first.events.at(-1)!.id);
  const second = (await (
    await jobEvents(new Request(url + '&cursor=' + first.nextCursor))
  ).json()) as { events: { id: string }[]; nextCursor: null };
  expect(second.events).toHaveLength(1);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set([...first.events, ...second.events].map((e) => e.id)).size,
  ).toBe(51);
  await mocks.db
    .prepare(
      "INSERT INTO session_preparation_job_events(id,owner_id,project_id,session_id,job_id,document,created_at) VALUES(?,?,?,?,?,'{}',?)",
    )
    .bind(
      crypto.randomUUID().replaceAll('-', ''),
      owner,
      projectId,
      sessionId,
      job.id,
      new Date().toISOString(),
    )
    .run();
  expect((await jobEvents(new Request(url))).status).toBe(503);
}, 30000);

const cancelJob = (id: string) =>
  jobPost(request({ action: 'cancel', id, projectId, sessionId }));
it('cancels one owned queued job idempotently, retains its transition and allows a fresh replacement', async () => {
  await create();
  const { job } = await queueJob();
  mocks.user = { userId: 'foreign' };
  expect((await cancelJob(job.id)).status).toBe(404);
  mocks.user = null;
  expect((await cancelJob(job.id)).status).toBe(401);
  mocks.user = { userId: owner };
  expect((await cancelJob(crypto.randomUUID())).status).toBe(404);
  expect((await cancelJob('invalid')).status).toBe(400);
  expect((await cancelJob(job.id)).status).toBe(200);
  expect((await cancelJob(job.id)).status).toBe(200);
  expect(await count('session_preparation_job_events')).toBe(2);
  const service = vi.fn(async () => Response.json({}, { status: 502 }));
  expect(
    (await runSessionPreparationJobs(mocks.db, service, jobScope(), 1))
      .processed,
  ).toBe(0);
  expect(service).not.toHaveBeenCalled();
  const page = (await (await jobsRead()).json()) as {
    jobs: { id: string; state: string }[];
  };
  expect(page.jobs[0]).toMatchObject({ id: job.id, state: 'cancelled' });
  const replacement = await queueJob();
  expect(replacement.job.id).not.toBe(job.id);
  await mocks.db
    .prepare('UPDATE imported_token_projects SET archived=1 WHERE owner_id=?')
    .bind(owner)
    .run();
  expect((await cancelJob(replacement.job.id)).status).toBe(200);
});
it('cancels an active lease and ignores a late successful unsigned result', async () => {
  await create();
  const { job } = await queueJob();
  let release!: (response: Response) => void;
  const pending = runSessionPreparationJobs(
    mocks.db,
    () =>
      new Promise<Response>((r) => {
        release = r;
      }),
    jobScope(),
    1,
  );
  while (!release) await new Promise((r) => setTimeout(r, 10));
  expect((await cancelJob(job.id)).status).toBe(200);
  release(Response.json({ history: { id: preparationId } }));
  await pending;
  const row = await mocks.db
    .prepare(
      'SELECT state,lease_token,lease_until,preparation_id,payload FROM session_preparation_jobs WHERE owner_id=? AND id=?',
    )
    .bind(owner, job.id)
    .first();
  expect(row).toMatchObject({
    state: 'cancelled',
    lease_token: null,
    lease_until: null,
    preparation_id: null,
    payload: null,
  });
  expect(await count('session_preparation_job_events')).toBe(3);
  expect(await count('imported_swap_signing_intents')).toBe(0);
});
it('rolls back job cancellation when history capture fails and refuses terminal jobs', async () => {
  await create();
  const { job } = await queueJob();
  await mocks.db
    .prepare(
      "CREATE TRIGGER reject_job_cancel_capture BEFORE INSERT ON session_preparation_job_events WHEN json_extract(NEW.document,'$.state')='cancelled' BEGIN SELECT RAISE(ABORT,'fixture capture unavailable'); END;",
    )
    .run();
  expect((await cancelJob(job.id)).status).toBe(409);
  expect(
    (
      await mocks.db
        .prepare(
          'SELECT state FROM session_preparation_jobs WHERE owner_id=? AND id=?',
        )
        .bind(owner, job.id)
        .first()
    )?.state,
  ).toBe('queued');
  await mocks.db.prepare('DROP TRIGGER reject_job_cancel_capture').run();
  await mocks.db
    .prepare(
      "UPDATE session_preparation_jobs SET state='failed',last_error='context-changed' WHERE owner_id=? AND id=?",
    )
    .bind(owner, job.id)
    .run();
  expect((await cancelJob(job.id)).status).toBe(409);
  expect(await count('session_preparation_job_events')).toBe(2);
});
