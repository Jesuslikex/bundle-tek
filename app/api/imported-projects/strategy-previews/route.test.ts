import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { ImportedSwapBalance } from '@/lib/imported-swap-balance';
import { assessImportedSwapBalance } from '@/lib/imported-swap-balance';
import { strategyCheckStorage } from '../../../../test/strategy-check-storage';
import { nativeWarmupFixture } from '../../../../test/warmup-native-fixture';
import {
  strategyInput,
  strategyProject,
  strategyWallet,
} from '../../../../test/strategy-session-fixture';
import {
  checkDraftId,
  checkHoldId,
} from '../../../../test/strategy-check-fixture';
import {
  saveStrategyDraft,
  archiveStrategyDraft,
} from '@/lib/strategy-session-drafts';
import {
  changeStrategyReviewCapacity,
  readStrategyReviewCapacity,
} from '@/lib/strategy-review-capacity-server';
import { readStrategyUnsignedPreview } from '@/lib/strategy-unsigned-preview-client';
import { readStrategyDraft } from '@/lib/strategy-session-drafts';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { TOKEN_PROGRAMS } from '@/lib/wallet-holdings';
import { POST } from './route';
const state = vi.hoisted(() => ({
  user: 'owner' as string | null,
  db: null as D1Database | null,
  balance: null as ImportedSwapBalance | null,
  env: { JUPITER_API_KEY: 'fixture-only' },
  observe: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => (state.user ? { userId: state.user } : null),
}));
vi.mock('@/db', () => ({ getD1: () => state.db }));
vi.mock('@/lib/server-env', () => ({ env: state.env }));
vi.mock('@/lib/imported-swap-balance', async (original) => ({
  ...(await original<typeof import('@/lib/imported-swap-balance')>()),
  observeImportedSwapBalance: (...args: unknown[]) => {
    state.observe(...args);
    return Promise.resolve(state.balance);
  },
}));
let store: Awaited<ReturnType<typeof strategyCheckStorage>>,
  f: Awaited<ReturnType<typeof nativeWarmupFixture>>;
let marketReads = 0,
  marketCap = '100000',
  secondCap: string | null = null,
  hook: (() => Promise<void>) | null = null;
const request = {
  projectId: strategyProject,
  draftId: checkDraftId,
  revision: 1,
  holdId: checkHoldId,
  conditionPool: null as string | null,
};
const post = (
  body: unknown = request,
  origin = 'https://bundle.test',
  signal?: AbortSignal,
) =>
  POST(
    new Request('https://bundle.test/api/imported-projects/strategy-previews', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(body),
      signal,
    }),
  );
async function setup(kind: 'DCA' | 'Limit' = 'DCA') {
  const token = {
    chain: 'Solana' as const,
    address: f.mint,
    decimals: 6,
    symbol: 'FIX',
    tokenProgram: TOKEN_PROGRAMS[0],
  };
  await store.client.execute({
    sql: 'UPDATE imported_token_projects SET document=?',
    args: [JSON.stringify({ token })],
  });
  await store.client.execute({
    sql: 'INSERT INTO workspace_wallets VALUES(?,?,?,?,0)',
    args: ['owner', 'Solana', f.wallet, 1],
  });
  const input = strategyInput();
  input.side = f.order.side;
  input.startAt = new Date(Date.now() - 1000).toISOString();
  input.maxAmount = null;
  const row = input.strategies.find((s) => s.kind === kind)!;
  row.wallet = f.wallet;
  row.walletRevision = 1;
  row.maxAmount = null;
  const amount = formatNativeBalance(
    f.order.inAmount,
    f.order.side === 'Buy' ? 9 : 6,
  );
  if (row.kind === 'DCA') {
    row.amountPerCycle = amount;
    row.cycles = 2;
  } else row.amount = amount;
  input.strategies = [row];
  await saveStrategyDraft(store.db, 'owner', checkDraftId, input);
  await changeStrategyReviewCapacity(
    store.db,
    'owner',
    strategyProject,
    checkDraftId,
    0,
    { kind: 'hold', id: checkHoldId, strategyId: row.id, candidate: 0 },
  );
  request.conditionPool = kind === 'Limit' ? strategyWallet : null;
  state.balance = {
    ...assessImportedSwapBalance(
      token,
      f.wallet,
      'Buy',
      amount,
      {
        chain: 'Solana',
        address: f.wallet,
        holdings: [],
        accountCount: 0,
        slots: [{ program: TOKEN_PROGRAMS[0], slot: 100 }],
        commitment: 'confirmed',
        minSlot: 100,
        maxSlot: 100,
        source: 'fixture.invalid',
        observedAt: new Date().toISOString(),
      },
      '1000000000',
    ),
    nativeSlot: 100,
  };
}
async function resetLimit(kind: 'DCA' | 'Limit' = 'Limit') {
  store.client.close();
  store = await strategyCheckStorage();
  state.db = store.db;
  await store.client.execute(
    'CREATE TABLE wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER NOT NULL)',
  );
  await setup(kind);
}
beforeEach(async () => {
  store = await strategyCheckStorage();
  state.db = store.db;
  state.user = 'owner';
  state.observe.mockReset();
  state.env.JUPITER_API_KEY = 'fixture-only';
  await store.client.execute(
    'CREATE TABLE wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER NOT NULL)',
  );
  f = await nativeWarmupFixture();
  marketReads = 0;
  marketCap = '100000';
  secondCap = null;
  hook = null;
  await setup();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const host = new URL(String(url)).hostname;
      if (host === 'api.dexscreener.com') {
        marketReads++;
        const cap =
          marketReads > 1 && secondCap !== null ? secondCap : marketCap;
        return new Response(
          `[{"chainId":"solana","dexId":"pump","pairAddress":"${strategyWallet}","baseToken":{"address":"${f.mint}"},"quoteToken":{"address":"So11111111111111111111111111111111111111112","symbol":"SOL"},"marketCap":${cap}}]`,
        );
      }
      if (host === 'api.jup.ag') {
        const query = new URL(String(url)).searchParams;
        expect(query.get('taker')).toBe(f.wallet);
        expect(query.get('amount')).toBe(f.order.inAmount);
        // dflow stays available for wallet-bound orders; it is the only fallback when Metis is empty.
        expect(query.get('excludeRouters')).toBe('jupiterz,okx');
        return Response.json({
          inputMint: f.order.inputMint,
          outputMint: f.order.outputMint,
          inAmount: f.order.inAmount,
          outAmount: f.order.outAmount,
          otherAmountThreshold: f.order.minimumOutAmount,
          swapMode: 'ExactIn',
          slippageBps: 50,
          router: 'metis',
          ...(f.order.platformFee
            ? {
                platformFee: {
                  feeBps: f.order.platformFee.bps,
                  feeMint: f.order.platformFee.mint,
                },
                feeBps: f.order.platformFee.bps,
                feeMint: f.order.platformFee.mint,
              }
            : {}),
          taker: f.wallet,
          gasless: false,
          transactionVersion: 0,
          transaction: f.order.preparation.transaction,
          lastValidBlockHeight: f.order.preparation.lastValidBlockHeight,
          signatureFeeLamports: 5000,
          signatureFeePayer: f.wallet,
          prioritizationFeeLamports: 0,
          rentFeeLamports: 0,
        });
      }
      const method = JSON.parse(
        typeof init?.body === 'string' ? init.body : '{}',
      ).method;
      if (method === 'simulateTransaction' && hook) {
        const run = hook;
        hook = null;
        await run();
      }
      return f.fetcher(url, init);
    }),
  );
});
afterEach(() => {
  store.client.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('runs actual unsigned quote parsing, exact packet simulation and settlement review through HTTP and owned libSQL without financial storage', async () => {
  const before = await readStrategyReviewCapacity(
    store.db,
    'owner',
    strategyProject,
    checkDraftId,
  );
  const response = await post();
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  expect(value).toMatchObject({
    format: 'strategy-unsigned-preview-v1',
    conditionPool: null,
    planningOnly: true,
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
    quote: { inputRaw: f.order.inAmount, sha256: f.order.preparation.sha256 },
    simulation: { networkFeeLamports: '5000' },
  });
  expect(JSON.stringify(value)).not.toContain(f.order.preparation.transaction);
  expect(
    await readStrategyReviewCapacity(
      store.db,
      'owner',
      strategyProject,
      checkDraftId,
    ),
  ).toEqual(before);
  const draft = await readStrategyDraft(
    store.db,
    'owner',
    strategyProject,
    checkDraftId,
  );
  expect(
    await readStrategyUnsignedPreview(value, draft, before, checkHoldId, null),
  ).toEqual(value);
  expect(marketReads).toBe(0);
  expect(state.observe).toHaveBeenCalledTimes(1);
  expect((await post()).status).toBe(429);
  expect(state.observe).toHaveBeenCalledTimes(1);
});
it('does not request an order for an unfunded wallet and leaves the held slot recoverable', async () => {
  state.balance = {
    ...state.balance!,
    nativeRaw: '0',
    amountCovered: false,
    shortfallRaw: f.order.inAmount,
  };
  const response = await post();
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    error: expect.stringMatching(/insufficient input/),
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(
    (
      await readStrategyReviewCapacity(
        store.db,
        'owner',
        strategyProject,
        checkDraftId,
      )
    ).state.holds[0].state,
  ).toBe('held');
});
it.each(['owner', 'wallet', 'release', 'archive'] as const)(
  'discards an in-flight unsigned preview after %s context changes',
  async (kind) => {
    hook = async () => {
      if (kind === 'owner')
        await store.client.execute(
          "UPDATE imported_token_projects SET owner_id='other'",
        );
      if (kind === 'wallet')
        await store.client.execute('UPDATE workspace_wallets SET revision=2');
      if (kind === 'release')
        await changeStrategyReviewCapacity(
          store.db,
          'owner',
          strategyProject,
          checkDraftId,
          1,
          { kind: 'release', id: checkHoldId },
        );
      if (kind === 'archive')
        await archiveStrategyDraft(
          store.db,
          'owner',
          strategyProject,
          checkDraftId,
          1,
          true,
        );
    };
    expect((await post()).status).toBe(kind === 'owner' ? 404 : 409);
    expect(hook).toBeNull();
  },
);
it('uses the selected Limit pool, works immediately after a lightweight market check, and checks that pool again after simulation', async () => {
  await resetLimit();
  await store.client.execute({
    sql: 'INSERT INTO market_read_gates VALUES(?,?)',
    args: ['owner', Date.now() + 15000],
  });
  const response = await post();
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(
    200,
  );
  expect(marketReads).toBe(2);
});
it.each(['99999', '0'] as const)(
  'withholds the preview when final selected-pool market cap becomes %s',
  async (cap) => {
    await resetLimit();
    secondCap = cap;
    expect((await post()).status).toBe(409);
    expect(marketReads).toBe(2);
  },
);
it('rejects an unmet Limit before balance or order reads', async () => {
  await resetLimit();
  marketCap = '99999';
  expect((await post()).status).toBe(409);
  expect(state.observe).not.toHaveBeenCalled();
  expect(marketReads).toBe(1);
});
it('requires observed SOL for the exact simulated fee and account-rent debit', async () => {
  state.balance = { ...state.balance!, nativeRaw: f.order.inAmount };
  const response = await post();
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    error: expect.stringMatching(/fees and account rent/),
  });
});
it('rejects authentication, cross-origin, foreign drafts, extra authority fields and wrong pool shape before provider reads', async () => {
  state.user = null;
  expect((await post()).status).toBe(401);
  state.user = 'other';
  expect((await post()).status).not.toBe(200);
  state.user = 'owner';
  expect((await post(request, 'https://evil.example')).status).toBe(400);
  for (const changed of [
    { ...request, transaction: 'packet' },
    { ...request, executionAllowed: true },
    { ...request, conditionPool: {} },
    { ...request, revision: 0 },
  ])
    expect((await post(changed)).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
  expect(state.observe).not.toHaveBeenCalled();
});
it('honors cancellation before starting provider work', async () => {
  const controller = new AbortController();
  controller.abort();
  expect(
    (await post(request, 'https://bundle.test', controller.signal)).status,
  ).not.toBe(200);
  expect(fetch).not.toHaveBeenCalled();
});
it('times out a non-cooperative quote provider and never simulates a late order', async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  let release: (value: Response) => void = () => {},
    started: () => void = () => {};
  const began = new Promise<void>((resolve) => (started = resolve));
  let orderCall: { url: unknown; init?: RequestInit } | null = null;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: unknown, init?: RequestInit) => {
      if (new URL(String(url)).hostname === 'api.jup.ag') {
        orderCall = { url, init };
        started();
        return new Promise<Response>((resolve) => (release = resolve));
      }
      return original(url as RequestInfo, init);
    }),
  );
  vi.useFakeTimers();
  const pending = post();
  await began;
  await vi.advanceTimersByTimeAsync(25000);
  expect((await pending).status).toBe(502);
  const call = orderCall! as { url: unknown; init?: RequestInit };
  expect(call.init?.signal?.aborted).toBe(true);
  const count = vi.mocked(fetch).mock.calls.length;
  release(await original(call.url as RequestInfo, call.init));
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch).toHaveBeenCalledTimes(count);
});
it('previews exact token-input Sell units through the real quote parser and native settlement verifier', async () => {
  f = await nativeWarmupFixture({ side: 'Sell' });
  await resetLimit('DCA');
  state.balance = {
    ...state.balance!,
    side: 'Sell',
    requestedRaw: f.order.inAmount,
  };
  const response = await post();
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(
    200,
  );
  expect(await response.json()).toMatchObject({
    checks: { side: 'Sell', unitsRaw: f.order.inAmount },
    quote: {
      inputMint: f.mint,
      outputMint: f.order.outputMint,
      inputRaw: f.order.inAmount,
    },
  });
});
it('rejects provider-returned signed packet bytes before simulation and does not expose them', async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const response = await original(url, init);
      if (
        new URL(
          typeof url === 'string'
            ? url
            : url instanceof URL
              ? url.href
              : url.url,
        ).hostname !== 'api.jup.ag'
      )
        return response;
      const body = (await response.json()) as Record<string, unknown>;
      return Response.json({ ...body, transaction: f.signed.transaction });
    }),
  );
  const response = await post();
  expect(response.status).toBe(502);
  expect(JSON.stringify(await response.json())).not.toContain(
    f.signed.transaction,
  );
  expect(
    vi.mocked(fetch).mock.calls.filter((call) =>
      String(call[0]).startsWith('https://api.jup.ag'),
    ),
  ).toHaveLength(1);
});
it('retains an explicitly quoted platform fee independently of the network fee', async () => {
  f = await nativeWarmupFixture({ fee: 10 });
  await resetLimit('DCA');
  const response = await post();
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(
    200,
  );
  expect(await response.json()).toMatchObject({
    quote: { platformFeeBps: 10, platformFeeMint: f.order.inputMint },
    simulation: { networkFeeLamports: '5000' },
  });
});
