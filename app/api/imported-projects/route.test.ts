import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import bs58 from 'bs58';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import { TOKEN_PROGRAMS } from '@/lib/wallet-holdings';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  inspect: vi.fn(),
  quote: vi.fn(),
  sell: vi.fn(),
  holdings: vi.fn(),
  native: vi.fn(),
  prepare: vi.fn(),
  simulate: vi.fn(),
  market: vi.fn(),
  candles: vi.fn(),
  trades: vi.fn(),
  evmHoldings: vi.fn(),
}));
vi.mock('@/lib/evm-holdings', async (original) => ({
  ...(await original<typeof import('@/lib/evm-holdings')>()),
  observeEvmHoldings: mocks.evmHoldings,
}));
vi.mock('@/lib/pool-trades', async (original) => ({
  ...(await original<typeof import('@/lib/pool-trades')>()),
  observePoolTrades: mocks.trades,
}));
vi.mock('@/lib/pool-candles', async (original) => ({
  ...(await original<typeof import('@/lib/pool-candles')>()),
  observePoolCandles: mocks.candles,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({
  getD1: () => {
    if (!mocks.db) throw new Error('No database');
    return mocks.db;
  },
}));
vi.mock('@/lib/token-import', () => ({ inspectToken: mocks.inspect }));
vi.mock('@/lib/token-market', async (original) => ({
  ...(await original<typeof import('@/lib/token-market')>()),
  observeTokenMarket: mocks.market,
}));
vi.mock('@/lib/warmup-swap-quote', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/warmup-swap-quote')>()),
  quoteSolanaBuy: mocks.quote,
  quoteSolanaSell: mocks.sell,
  prepareSolanaSwap: mocks.prepare,
}));
import { env } from 'cloudflare:workers';
const quoteEnv = env as unknown as Record<string, string | undefined>;
import { POST as quotePOST } from './quote/route';
import { GET, POST } from './route';
import { GET as historyGET } from './events/route';
import { GET as activityGET } from './activity/route';
import { POST as balancePOST } from './balance/route';
import { POST as preparePOST } from './prepare/route';
import { GET as preparationsGET } from './preparations/route';
import { saveSwapPreparation } from '@/lib/imported-swap-preparation-history';
import { preparationHistoryFixture } from '../../../test/imported-preparation-history-fixture';
import { GET as marketGET, POST as marketPOST } from './market/route';
import { GET as candlesGET, POST as candlesPOST } from './candles/route';
import { GET as tradesGET, POST as tradesPOST } from './trades/route';
import {
  GET as evmBalanceGET,
  POST as evmBalancePOST,
} from './evm-balance/route';
vi.mock('@/lib/imported-swap-simulation', () => ({
  simulateImportedSwap: mocks.simulate,
}));
vi.mock('@/lib/wallet-holdings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/wallet-holdings')>()),
  observeWalletHoldings: mocks.holdings,
}));
vi.mock('@/lib/wallet-balances', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/wallet-balances')>()),
  balanceRpc: mocks.native,
}));
import type { ImportedTokenProject } from '@/lib/imported-token-project';
const read = async (response: Response) =>
  (await response.json()) as {
    project: ImportedTokenProject;
    projects: ImportedTokenProject[];
  };
let mf: Miniflare;
const token = {
  chain: 'Solana',
  address: 'So11111111111111111111111111111111111111112',
  name: 'Wrapped SOL',
  symbol: 'SOL',
  decimals: 9,
  totalSupplyRaw: '18446744073709551615',
  metadataUri: 'https://example.test/private',
  source: 'https://rpc.example.test/path?key=secret',
  observedAt: '2026-10-10T08:00:00.000Z',
  contextSlot: 123,
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
};
// Answers the balance reader's RPC sequence: genesis, mint, token accounts and
// native balance. Integers arrive as strings, as balanceRpc returns them.
type ChainAccount = {
  readonly raw: string;
  readonly state?: 'initialized' | 'frozen';
  readonly extensions?: readonly string[];
};
type ChainFixture = {
  readonly program?: string;
  readonly decimals?: number;
  readonly mintExtensions?: readonly string[];
  readonly mintSlot?: number;
  readonly accountSlot?: number;
  readonly accounts?: readonly ChainAccount[];
  readonly nativeSlot?: string;
  readonly nativeRaw?: string;
};
function solanaChain(fixture: ChainFixture = {}) {
  const program = fixture.program ?? TOKEN_PROGRAMS[0],
    token2022 = program === TOKEN_PROGRAMS[1],
    decimals = String(fixture.decimals ?? 6);
  return async (_endpoint: string, method: string, params: unknown[]) => {
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getAccountInfo')
      return {
        context: { slot: String(fixture.mintSlot ?? 102) },
        value: {
          owner: program,
          executable: false,
          data: {
            space: token2022 ? '250' : '82',
            parsed: {
              type: 'mint',
              info: {
                decimals,
                isInitialized: true,
                ...(fixture.mintExtensions
                  ? {
                      extensions: fixture.mintExtensions.map((extension) => ({
                        extension,
                      })),
                    }
                  : {}),
              },
            },
          },
        },
      };
    if (method === 'getTokenAccountsByOwner') {
      const [wallet, { mint }] = params as [string, { mint: string }];
      return {
        context: {
          slot: String(fixture.accountSlot ?? fixture.mintSlot ?? 102),
        },
        value: (fixture.accounts ?? []).map((account, i) => ({
          pubkey: bs58.encode(new Uint8Array(32).fill(10 + i)),
          account: {
            owner: program,
            executable: false,
            data: {
              space: token2022 ? '180' : '165',
              parsed: {
                type: 'account',
                info: {
                  mint,
                  owner: wallet,
                  state: account.state ?? 'initialized',
                  tokenAmount: { amount: account.raw, decimals },
                  ...(token2022
                    ? {
                        extensions: (
                          account.extensions ?? ['immutableOwner']
                        ).map((extension) => ({ extension })),
                      }
                    : {}),
                },
              },
            },
          },
        })),
      };
    }
    if (method === 'getBalance')
      return {
        context: { slot: fixture.nativeSlot ?? '102' },
        value: fixture.nativeRaw ?? '10000000',
      };
    throw new Error(`Unexpected balance RPC ${method}`);
  };
}
const post = (body: object, headers = {}) =>
  POST(
    new Request('http://localhost/api/imported-projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
const create = () =>
  post({
    action: 'import',
    chain: token.chain,
    address: token.address,
    name: 'Forged',
    executionAllowed: true,
  });
const count = async () =>
  (await mocks.db
    .prepare('SELECT COUNT(*) AS count FROM imported_token_project_events')
    .first<{ count: number }>())!.count;
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'imports-test',
          type: 'worker',
          compatibilityDate: '2026-09-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents:
                  'export default {fetch(){return new Response("test")}}',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'imports-test-only' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'imports-test',
  )) as unknown as D1Database;
  for (const sql of readFileSync(
    new URL(
      '../../../drizzle/0024_imported_token_projects.sql',
      import.meta.url,
    ),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
  await mocks.db
    .prepare(
      'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER,PRIMARY KEY(owner_id,chain,address))',
    )
    .run();
  await mocks.db
    .prepare(
      'CREATE TABLE wallet_balance_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
    )
    .run();
  for (const statement of readFileSync(
    new URL(
      '../../../drizzle/0041_imported_swap_preparations.sql',
      import.meta.url,
    ),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((value) => value.trim()))
    await mocks.db.prepare(statement).run();
  for (const sql of readFileSync(
    new URL(
      '../../../drizzle/0033_imported_market_observations.sql',
      import.meta.url,
    ),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .filter((s) => s.trim()))
    await mocks.db.prepare(sql).run();
});
beforeEach(async () => {
  mocks.candles.mockReset();
  mocks.trades.mockReset();
  mocks.evmHoldings.mockReset();
  await mocks.db.prepare('DELETE FROM imported_evm_balances').run();
  await mocks.db.prepare('DELETE FROM imported_pool_trades').run();
  mocks.simulate.mockReset().mockImplementation(async (order) => ({
    executionAllowed: false,
    instructionsVerified: false,
    succeeded: true,
    sha256: order.preparation.sha256,
    wallet: order.preparation.wallet,
    source: 'rpc.test',
    observedAt: new Date().toISOString(),
    feeSlot: 102,
    simulationSlot: 103,
    networkFeeLamports: '5000',
    unitsConsumed: '1000',
    nativeChangeRaw: '-5000',
    tokensComplete: false,
    inputAmountMatches: null,
    minimumOutputCovered: null,
    logs: ['private-simulation-log-sentinel'],
  }));
  mocks.prepare.mockReset().mockImplementation(async (input) => ({
    executionAllowed: false,
    side: input.side,
    inputMint:
      input.side === 'Sell'
        ? input.tokenMint
        : 'So11111111111111111111111111111111111111112',
    outputMint:
      input.side === 'Buy'
        ? input.tokenMint
        : 'So11111111111111111111111111111111111111112',
    inAmount: '1',
    outAmount: '1000',
    minimumOutAmount: '995',
    slippageBps: 50,
    router: 'metis',
    source: 'api.jup.ag',
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    preparation: {
      executionAllowed: false,
      instructionsVerified: false,
      wallet: input.wallet,
      sha256: 'a'.repeat(64),
      transaction: 'packet-not-retained',
      transactionBytes: 300,
      instructionCount: 2,
      lookupTableCount: 0,
      lastValidBlockHeight: '200',
      estimatedFeesLamports: '5000',
    },
  }));
  delete quoteEnv.JUPITER_API_KEY;
  mocks.sell.mockReset().mockResolvedValue({
    executionAllowed: false,
    side: 'Sell',
    expiresAt: new Date(Date.now() + 30000).toISOString(),
  });
  mocks.quote.mockReset().mockResolvedValue({
    executionAllowed: false,
    expiresAt: new Date(Date.now() + 30000).toISOString(),
  });
  for (const table of [
    'imported_swap_preparations',
    'imported_pool_candles',
    'imported_market_observations',
    'market_read_gates',
    'workspace_wallets',
    'wallet_balance_gates',
    'imported_token_project_events',
    'imported_token_projects',
    'imported_token_project_gates',
  ])
    await mocks.db.prepare(`DELETE FROM ${table}`).run();
  mocks.user = { userId: 'alice' };
  mocks.market.mockReset().mockResolvedValue({
    chain: token.chain,
    address: token.address,
    source: 'api.dexscreener.com',
    observedAt: '2026-10-10T15:00:00.000Z',
    pairs: [],
    returnedPairCount: 0,
    quoteOnlyPairCount: 0,
    executionAllowed: false,
  });
  mocks.inspect.mockReset().mockResolvedValue(token);
  mocks.holdings.mockReset().mockResolvedValue({
    chain: 'Solana',
    address: '11111111111111111111111111111111',
    holdings: [],
    accountCount: 0,
    slots: [],
    minSlot: 100,
    maxSlot: 101,
    observedAt: new Date().toISOString(),
    source: 'rpc.test',
    commitment: 'confirmed',
  });
  mocks.native
    .mockReset()
    .mockResolvedValue({ context: { slot: '102' }, value: '0' });
});
afterAll(async () => {
  await mf.dispose();
});
it('retains owned preparation summaries across archives and pages tied timestamps without provider reads', async () => {
  const document = preparationHistoryFixture();
  mocks.inspect.mockResolvedValue({
    ...token,
    address: document.inputMint,
    decimals: 6,
  });
  const { project } = await read(
    await post({
      action: 'import',
      chain: 'Solana',
      address: document.inputMint,
    }),
  );
  const query = (cursor?: string) =>
    preparationsGET(
      new Request(
        `http://localhost/api/imported-projects/preparations?id=${project.id}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
    );
  mocks.user = null;
  expect((await query()).status).toBe(401);
  mocks.user = { userId: 'bob' };
  expect((await query()).status).toBe(404);
  mocks.user = { userId: 'alice' };
  const timestamp = '2026-10-10T16:00:00.000Z';
  for (let i = 1; i <= 23; i++)
    await mocks.db
      .prepare('INSERT INTO imported_swap_preparations VALUES(?,?,?,?,?,?,?,?)')
      .bind(
        `00000000-0000-4000-8000-${i.toString().padStart(12, '0')}`,
        'alice',
        project.id,
        1,
        document.wallet,
        1,
        JSON.stringify(document),
        timestamp,
      )
      .run();
  const page = (await (await query()).json()) as {
    preparations: Array<{ id: string }>;
    nextCursor: string;
  };
  expect(page.preparations).toHaveLength(20);
  const older = (await (await query(page.nextCursor)).json()) as {
    preparations: Array<{ id: string }>;
    nextCursor: string | null;
  };
  expect(older.preparations).toHaveLength(3);
  expect(older.nextCursor).toBeNull();
  expect(
    new Set([...page.preparations, ...older.preparations].map((row) => row.id))
      .size,
  ).toBe(23);
  expect(
    (
      await query(
        JSON.stringify({ ...JSON.parse(page.nextCursor), extra: true }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await query(
        JSON.stringify({ createdAt: timestamp, id: crypto.randomUUID() }),
      )
    ).status,
  ).toBe(400);
  await post({ action: 'archive', id: project.id, expectedRevision: 1 });
  expect((await query()).status).toBe(200);
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.simulate).not.toHaveBeenCalled();
  expect(mocks.native).not.toHaveBeenCalled();
});
it('admits preparation history only for current active project/mint/wallet context and enforces its 200-record cap', async () => {
  const document = preparationHistoryFixture();
  mocks.inspect.mockResolvedValue({
    ...token,
    address: document.inputMint,
    decimals: 6,
  });
  const { project } = await read(
    await post({
      action: 'import',
      chain: 'Solana',
      address: document.inputMint,
    }),
  );
  await mocks.db
    .prepare("INSERT INTO workspace_wallets VALUES('alice','Solana',?,1,0)")
    .bind(document.wallet)
    .run();
  const context = {
    projectId: project.id,
    projectRevision: 1,
    wallet: document.wallet,
    walletRevision: 1,
  };
  const save = (patch = {}, snapshot = document) =>
    saveSwapPreparation(mocks.db, 'alice', { ...context, ...patch }, snapshot);
  expect(await save({ walletRevision: 2 })).toBeNull();
  expect(await save({ projectRevision: 2 })).toBeNull();
  expect(
    await save(
      {},
      { ...document, inputMint: '11111111111111111111111111111111' },
    ),
  ).toBeNull();
  expect(
    await save({}, { ...document, expiresAt: new Date(0).toISOString() }),
  ).toBeNull();
  expect(await save()).not.toBeNull();
  await mocks.db
    .prepare("UPDATE workspace_wallets SET archived=1 WHERE owner_id='alice'")
    .run();
  expect(await save()).toBeNull();
  await mocks.db
    .prepare("UPDATE workspace_wallets SET archived=0 WHERE owner_id='alice'")
    .run();
  await mocks.db.prepare('DELETE FROM imported_swap_preparations').run();
  await mocks.db
    .prepare(`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<200)
    INSERT INTO imported_swap_preparations SELECT printf('00000000-0000-4000-8000-%012d',i),'alice',?,1,?,1,?,? FROM seq`)
    .bind(
      project.id,
      document.wallet,
      JSON.stringify(document),
      new Date().toISOString(),
    )
    .run();
  expect(await save()).toBeNull();
  expect(
    (await mocks.db
      .prepare('SELECT COUNT(*) AS n FROM imported_swap_preparations')
      .first<{ n: number }>())!.n,
  ).toBe(200);
  quoteEnv.JUPITER_API_KEY = 'test-server-key';
  const full = await preparePOST(
    new Request('http://localhost/api/imported-projects/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: project.id,
        revision: 1,
        wallet: document.wallet,
        walletRevision: 1,
        side: 'Sell',
        amount: '0.000001',
        slippageBps: 50,
      }),
    }),
  );
  expect(full.status).toBe(409);
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.simulate).not.toHaveBeenCalled();
  expect(mocks.native).not.toHaveBeenCalled();
});

const marketRead = (project: ImportedTokenProject) =>
  marketGET(
    new Request(
      `http://localhost/api/imported-projects/market?id=${project.id}&revision=${project.revision}`,
    ),
  );
const marketRefresh = (project: ImportedTokenProject, headers = {}) =>
  marketPOST(
    new Request('http://localhost/api/imported-projects/market', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ id: project.id, revision: project.revision }),
    }),
  );
it('retains owned market reads without RPC on reopen, caps the rolling series and keeps archived observations readable', async () => {
  const { project } = await read(await create());
  expect(await (await marketRead(project)).json()).toMatchObject({
    observations: [],
    executionAllowed: false,
  });
  expect(mocks.market).not.toHaveBeenCalled();
  expect((await marketRefresh(project)).status).toBe(200);
  expect((await marketRefresh(project)).status).toBe(429);
  expect(mocks.market.mock.calls[0][0]).toEqual({
    chain: token.chain,
    address: token.address,
  });
  const saved = (await (await marketRead(project)).json()) as {
    observations: Array<Record<string, unknown>>;
  };
  expect(saved.observations[0]).toMatchObject({
    projectRevision: 1,
    observedAt: '2026-10-10T15:00:00.000Z',
  });
  const history = Array.from({ length: 20 }, (_, i) => ({
    ...saved.observations[0],
    observedAt: new Date(
      Date.parse('2026-10-10T15:00:00.000Z') - i * 1000,
    ).toISOString(),
  }));
  await mocks.db
    .prepare('UPDATE imported_market_observations SET document=?')
    .bind(JSON.stringify(history))
    .run();
  await mocks.db.prepare('DELETE FROM market_read_gates').run();
  mocks.market.mockResolvedValue({
    ...saved.observations[0],
    observedAt: '2026-10-10T15:01:00.000Z',
  });
  const refreshed = await marketRefresh(project);
  expect(refreshed.status).toBe(200);
  const updated = (await refreshed.json()) as { observations: unknown[] };
  expect(updated.observations).toHaveLength(20);
  expect(updated.observations).not.toContainEqual(history[19]);
  const { project: archived } = await read(
    await post({
      action: 'archive',
      id: project.id,
      expectedRevision: project.revision,
    }),
  );
  expect((await marketRefresh(archived)).status).toBe(409);
  expect((await marketRead(archived)).status).toBe(200);
  mocks.user = { userId: 'bob' };
  expect((await marketRead(archived)).status).toBe(404);
  expect((await marketRefresh(archived)).status).toBe(404);
  mocks.user = null;
  expect((await marketRead(archived)).status).toBe(401);
  expect((await marketRefresh(archived)).status).toBe(401);
});
it('preserves saved market observations across provider failures and rejects stale or cross-origin reads before the provider', async () => {
  const { project } = await read(await create());
  expect((await marketRefresh(project)).status).toBe(200);
  const first = await (await marketRead(project)).json();
  await mocks.db.prepare('DELETE FROM market_read_gates').run();
  mocks.market.mockRejectedValue(new Error('provider private details'));
  const failure = await marketRefresh(project);
  expect(failure.status).toBe(502);
  expect(await failure.text()).not.toContain('private details');
  expect(await (await marketRead(project)).json()).toEqual(first);
  mocks.market.mockClear();
  expect((await marketRefresh({ ...project, revision: 2 })).status).toBe(409);
  expect(
    (await marketRefresh(project, { origin: 'https://other.test' })).status,
  ).toBe(403);
  expect(mocks.market).not.toHaveBeenCalled();
  expect(
    (
      await marketGET(
        new Request(
          'http://localhost/api/imported-projects/market?id=bad&revision=1',
        ),
      )
    ).status,
  ).toBe(400);
});
it('rejects project changes and concurrent observation replacement during provider reads', async () => {
  const { project } = await read(await create());
  const value = {
    chain: token.chain,
    address: token.address,
    source: 'api.dexscreener.com',
    observedAt: '2026-10-10T15:00:00.000Z',
    pairs: [],
    returnedPairCount: 0,
    quoteOnlyPairCount: 0,
    executionAllowed: false,
  };
  mocks.market.mockImplementation(async () => {
    await mocks.db
      .prepare('INSERT INTO imported_market_observations VALUES (?,?,?,?)')
      .bind(
        'alice',
        project.id,
        JSON.stringify([{ ...value, projectRevision: 1 }]),
        value.observedAt,
      )
      .run();
    return { ...value, observedAt: '2026-10-10T15:01:00.000Z' };
  });
  expect((await marketRefresh(project)).status).toBe(409);
  expect(await (await marketRead(project)).json()).toMatchObject({
    observations: [expect.objectContaining({ observedAt: value.observedAt })],
  });
  await mocks.db.prepare('DELETE FROM market_read_gates').run();
  mocks.market.mockImplementation(async () => {
    await mocks.db
      .prepare('UPDATE imported_token_projects SET revision=2,archived=1')
      .run();
    return { ...value, observedAt: '2026-10-10T15:02:00.000Z' };
  });
  expect((await marketRefresh(project)).status).toBe(409);
  expect(
    await (await marketRead({ ...project, revision: 2 })).json(),
  ).toMatchObject({
    observations: [expect.objectContaining({ observedAt: value.observedAt })],
  });
});
describe('imported token projects', () => {
  it('prepares metadata-only Token-2022 sells after fresh mint checks and blocks unsupported capabilities before quoting', async () => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const program = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    const wallet = '11111111111111111111111111111111';
    mocks.inspect.mockResolvedValueOnce({
      ...token,
      address: mint,
      decimals: 6,
      tokenProgram: program,
    });
    const { project } = await read(
      await post({ action: 'import', chain: 'Solana', address: mint }),
    );
    await mocks.db
      .prepare("INSERT INTO workspace_wallets VALUES ('alice','Solana',?,1,0)")
      .bind(wallet)
      .run();
    quoteEnv.JUPITER_API_KEY = 'test-key';
    const originalPreparation = mocks.prepare.getMockImplementation()!;
    mocks.prepare.mockImplementation(async (input) => ({
      ...(await originalPreparation(input)),
      inAmount: '500000',
    }));
    const prepare = () =>
      preparePOST(
        new Request('http://localhost/api/imported-projects/prepare', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: project.id,
            revision: 1,
            wallet,
            walletRevision: 1,
            side: 'Sell',
            amount: '0.5',
          }),
        }),
      );
    for (const { mint: mintExtensions, account, status } of [
      { mint: ['transferFeeConfig'], status: 422 },
      { mint: ['transferHook'], status: 422 },
      { mint: ['unknownExtension'], status: 422 },
      { mint: null, status: 422 },
      {
        mint: ['metadataPointer'],
        account: ['transferFeeAmount'],
        status: 422,
      },
      { mint: ['metadataPointer', 'tokenMetadata'], status: 200 },
    ] as const) {
      await mocks.db.prepare('DELETE FROM imported_token_project_gates').run();
      await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
      mocks.prepare.mockClear();
      mocks.native.mockImplementation(
        solanaChain({
          program,
          decimals: 6,
          mintExtensions: mintExtensions ?? undefined,
          mintSlot: 102,
          accounts: [
            { raw: '1000000', extensions: account ?? ['immutableOwner'] },
          ],
          nativeSlot: '103',
        }),
      );
      const response = await prepare();
      expect(response.status).toBe(status);
      if (status === 422) {
        expect(mocks.prepare).not.toHaveBeenCalled();
        expect(
          await mocks.db
            .prepare('SELECT COUNT(*) AS n FROM imported_swap_preparations')
            .first(),
        ).toEqual({ n: 0 });
      } else {
        const data = (await response.json()) as {
          balance: unknown;
          history: { id: string };
        };
        expect(data.balance).toMatchObject({
          preparationSupported: true,
          amountCovered: true,
          requestedRaw: '500000',
          mintSlot: 102,
          nativeSlot: 103,
          mintExtensions: ['metadataPointer', 'tokenMetadata'],
          blockedExtensions: [],
          executionAllowed: false,
        });
        expect(mocks.prepare).toHaveBeenCalledTimes(1);
        expect(
          await mocks.db
            .prepare('SELECT id FROM imported_swap_preparations')
            .first(),
        ).toEqual({ id: data.history.id });
      }
    }
  });
  it('prepares only current owned mint and wallet revisions, and invalidates concurrent archive', async () => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    mocks.inspect.mockResolvedValueOnce({
      ...token,
      address: mint,
      decimals: 6,
    });
    const { project } = await read(
      await post({ action: 'import', chain: 'Solana', address: mint }),
    );
    const wallet = '11111111111111111111111111111111';
    await mocks.db
      .prepare("INSERT INTO workspace_wallets VALUES ('alice','Solana',?,1,0)")
      .bind(wallet)
      .run();
    const prepare = (patch = {}) =>
      preparePOST(
        new Request('http://localhost/api/imported-projects/prepare', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: project.id,
            revision: 1,
            wallet,
            walletRevision: 1,
            side: 'Sell',
            amount: '0.000001',
            decimals: 9,
            tokenMint: token.address,
            ...patch,
          }),
        }),
      );
    mocks.user = null;
    expect((await prepare()).status).toBe(401);
    mocks.user = { userId: 'bob' };
    expect((await prepare()).status).toBe(409);
    mocks.user = { userId: 'alice' };
    expect((await prepare({ walletRevision: 2 })).status).toBe(409);
    expect((await prepare({ amount: '0.0000001' })).status).toBe(400);
    expect((await prepare()).status).toBe(503);
    expect(mocks.prepare).not.toHaveBeenCalled();
    quoteEnv.JUPITER_API_KEY = 'test-key';
    for (const [fixture, status] of [
      // No inventory for this mint.
      [{ accounts: [] }, 422],
      // Frozen units are excluded from the sellable amount.
      [{ accounts: [{ raw: '1', state: 'frozen' }] }, 422],
      // Native context older than the mint inventory is not a usable balance.
      [{ accounts: [{ raw: '1' }], nativeSlot: '101' }, 502],
    ] as const) {
      await mocks.db.prepare('DELETE FROM imported_token_project_gates').run();
      await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
      mocks.native.mockImplementation(
        solanaChain({ mintSlot: 102, ...fixture }),
      );
      expect((await prepare()).status).toBe(status);
      expect(mocks.prepare).not.toHaveBeenCalled();
    }
    await mocks.db.prepare('DELETE FROM imported_token_project_gates').run();
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    const current = solanaChain({ mintSlot: 102, accounts: [{ raw: '1' }] });
    mocks.native.mockImplementation(current);
    mocks.native.mockImplementationOnce(async (endpoint, method, params) => {
      await mocks.db
        .prepare(
          "UPDATE workspace_wallets SET revision=2 WHERE owner_id='alice'",
        )
        .run();
      return current(endpoint, method, params);
    });
    expect((await prepare()).status).toBe(409);
    expect(mocks.prepare).not.toHaveBeenCalled();
    await mocks.db
      .prepare("UPDATE workspace_wallets SET revision=1 WHERE owner_id='alice'")
      .run();
    await mocks.db.prepare('DELETE FROM imported_token_project_gates').run();
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    const preparedResponse = await prepare();
    expect(preparedResponse.status).toBe(200);
    const preparedData = (await preparedResponse.json()) as {
      balance: unknown;
      history: { id: string };
    };
    expect(preparedData.balance).toMatchObject({
      requestedRaw: '1',
      amountCovered: true,
      nativeSlot: 102,
      preparationSupported: true,
      executionAllowed: false,
    });
    expect(preparedData.history.id).toMatch(/^[0-9a-f-]{36}$/);
    const savedPage = await preparationsGET(
      new Request(
        `http://localhost/api/imported-projects/preparations?id=${project.id}`,
      ),
    );
    expect(savedPage.status).toBe(200);
    const savedText = await savedPage.text();
    expect(savedText).toContain('a'.repeat(64));
    expect(savedText).not.toContain('packet-not-retained');
    expect(savedText).not.toContain('private-simulation-log-sentinel');
    expect(savedText).toContain('"executionAllowed":false');
    expect(mocks.prepare.mock.calls[0][0]).toEqual({
      tokenMint: mint,
      decimals: 6,
      side: 'Sell',
      amount: '0.000001',
      wallet,
    });
    expect(await count()).toBe(1);
    expect((await prepare()).status).toBe(429);
    expect(mocks.simulate).toHaveBeenCalledTimes(1);
    await mocks.db.prepare('DELETE FROM imported_token_project_gates').run();
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.simulate.mockImplementationOnce(async () => {
      await mocks.db
        .prepare(
          "UPDATE workspace_wallets SET revision=2 WHERE owner_id='alice'",
        )
        .run();
      return {
        executionAllowed: false,
        instructionsVerified: false,
        succeeded: true,
      };
    });
    expect((await prepare()).status).toBe(409);
    await mocks.db
      .prepare("UPDATE workspace_wallets SET revision=1 WHERE owner_id='alice'")
      .run();
    await mocks.db.prepare('DELETE FROM imported_token_project_gates').run();
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.prepare.mockImplementationOnce(async () => {
      await mocks.db
        .prepare(
          "UPDATE workspace_wallets SET revision=2 WHERE owner_id='alice'",
        )
        .run();
      return { expiresAt: new Date(Date.now() + 30000).toISOString() };
    });
    expect((await prepare()).status).toBe(409);
    await mocks.db
      .prepare("UPDATE workspace_wallets SET revision=1 WHERE owner_id='alice'")
      .run();
    await mocks.db.prepare('DELETE FROM imported_token_project_gates').run();
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.prepare.mockResolvedValueOnce({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect((await prepare()).status).toBe(409);
    await mocks.db.prepare('DELETE FROM imported_token_project_gates').run();
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    mocks.prepare.mockImplementationOnce(async () => {
      await post({ action: 'archive', id: project.id, expectedRevision: 1 });
      return { expiresAt: new Date(Date.now() + 30000).toISOString() };
    });
    expect((await prepare()).status).toBe(409);
  }, 15000);
  it('isolates imported activity and paginates immutable snapshots with tied timestamps', async () => {
    const { project } = await read(await create());
    const activity = (cursor?: string) =>
      activityGET(
        new Request(
          `http://localhost/api/imported-projects/activity${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        ),
      );
    mocks.user = null;
    expect((await activity()).status).toBe(401);
    mocks.user = { userId: 'bob' };
    expect(
      ((await (await activity()).json()) as { events: unknown[] }).events,
    ).toEqual([]);
    mocks.user = { userId: 'alice' };
    for (const cursor of [
      'bad',
      '[]',
      '["2026-02-31T00:00:00.000Z","00000000-0000-4000-8000-000000000000"]',
      JSON.stringify(['2026-10-10T08:00:00.000Z', 'bad']),
    ])
      expect((await activity(cursor)).status).toBe(400);
    await mocks.db.batch(
      Array.from({ length: 55 }, (_, i) =>
        mocks.db
          .prepare(
            'INSERT INTO imported_token_project_events(id,owner_id,project_id,type,revision,document,created_at) VALUES (?,?,?,?,?,?,?)',
          )
          .bind(
            `${(i + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
            'alice',
            project.id,
            'project.settings',
            i + 2,
            JSON.stringify({ ...project.document, secret: 'excluded' }),
            '2026-10-11T08:00:00.000Z',
          ),
      ),
    );
    const response = await activity();
    expect(response.headers.get('cache-control')).toBe('no-store');
    const first = (await response.json()) as {
      events: Array<{ id: string; token: { name: string } }>;
      nextCursor: string;
    };
    expect(first.events).toHaveLength(50);
    expect(first.events[0].token.name).toBe(token.name);
    expect(JSON.stringify(first)).not.toContain('secret');
    expect(first.events[0]).not.toHaveProperty('document');
    await mocks.db
      .prepare(
        'INSERT INTO imported_token_project_events(id,owner_id,project_id,type,revision,document,created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .bind(
        crypto.randomUUID(),
        'alice',
        project.id,
        'project.archive',
        57,
        JSON.stringify(project.document),
        '2026-10-12T08:00:00.000Z',
      )
      .run();
    const older = (await (await activity(first.nextCursor)).json()) as {
      events: Array<{ id: string }>;
      nextCursor: null;
    };
    expect(older.events).toHaveLength(6);
    expect(older.nextCursor).toBeNull();
    expect(
      new Set([...first.events, ...older.events].map((e) => e.id)).size,
    ).toBe(56);
  });
  it('saves exact preferences only for current owned active wallets and preserves revision history', async () => {
    const { project } = await read(await create());
    const wallet = '11111111111111111111111111111111';
    await mocks.db
      .prepare("INSERT INTO workspace_wallets VALUES ('alice','Solana',?,2,0)")
      .bind(wallet)
      .run();
    const settings = {
      side: 'Sell',
      amount: '1.000000001',
      wallet,
      walletRevision: 2,
      executionAllowed: true,
    };
    const save = (patch = {}, expectedRevision = 1) =>
      post({
        action: 'settings',
        id: project.id,
        expectedRevision,
        settings: { ...settings, ...patch },
      });
    for (const amount of ['0', '1e-9', '0.0000000001', '18446744073.709551616'])
      expect((await save({ amount })).status).toBe(400);
    expect((await save({ walletRevision: 1 })).status).toBe(409);
    const { project: saved } = await read(await save());
    expect(saved.revision).toBe(2);
    expect(saved.document.tradeSettings).toEqual({
      side: 'Sell',
      amount: '1.000000001',
      wallet,
      walletRevision: 2,
    });
    expect(saved.document.executionAllowed).toBe(false);
    expect((await save()).status).toBe(409);
    expect(mocks.inspect).toHaveBeenCalledTimes(1);
    await mocks.db.prepare('DELETE FROM imported_token_project_gates').run();
    const { project: refreshed } = await read(
      await post({ action: 'refresh', id: project.id, expectedRevision: 2 }),
    );
    expect(refreshed.document.tradeSettings).toEqual(
      saved.document.tradeSettings,
    );
    const { project: archived } = await read(
      await post({ action: 'archive', id: project.id, expectedRevision: 3 }),
    );
    expect(archived.document.tradeSettings).toEqual(
      saved.document.tradeSettings,
    );
    expect((await save({}, 4)).status).toBe(409);
    await post({ action: 'restore', id: project.id, expectedRevision: 4 });
    await mocks.db
      .prepare("UPDATE workspace_wallets SET archived=1 WHERE owner_id='alice'")
      .run();
    expect((await save({}, 5)).status).toBe(409);
    const history = await historyGET(
      new Request(
        `http://localhost/api/imported-projects/events?id=${project.id}`,
      ),
    );
    const body = (await history.json()) as {
      events: Array<{
        revision: number;
        type: string;
        document: ImportedTokenProject['document'];
      }>;
    };
    expect(body.events.find((e) => e.revision === 2)?.type).toBe(
      'project.settings',
    );
    expect(
      body.events.find((e) => e.revision === 1)?.document.tradeSettings,
    ).toBeUndefined();
    expect(await count()).toBe(5);
  });
  it('rejects a wallet changed between settings validation and the atomic project write', async () => {
    const { project } = await read(await create());
    const wallet = '11111111111111111111111111111111';
    await mocks.db
      .prepare("INSERT INTO workspace_wallets VALUES ('alice','Solana',?,1,0)")
      .bind(wallet)
      .run();
    const original = mocks.db;
    const batch = vi.fn(async (statements: D1PreparedStatement[]) => {
      await original
        .prepare(
          "UPDATE workspace_wallets SET revision=2 WHERE owner_id='alice'",
        )
        .run();
      return original.batch(statements);
    });
    mocks.db = {
      prepare: original.prepare.bind(original),
      batch,
    } as unknown as D1Database;
    try {
      expect(
        (
          await post({
            action: 'settings',
            id: project.id,
            expectedRevision: 1,
            settings: {
              side: 'Buy',
              amount: '0.01',
              wallet,
              walletRevision: 1,
            },
          })
        ).status,
      ).toBe(409);
      expect(batch).toHaveBeenCalledTimes(1);
      expect(await count()).toBe(1);
      expect((await read(await GET())).projects[0].revision).toBe(1);
    } finally {
      mocks.db = original;
    }
  });
  it('rejects changed wallet revisions and incoherent native balance snapshots', async () => {
    const { project } = await read(await create());
    const wallet = '11111111111111111111111111111111';
    await mocks.db
      .prepare("INSERT INTO workspace_wallets VALUES ('alice','Solana',?,1,0)")
      .bind(wallet)
      .run();
    const balance = () =>
      balancePOST(
        new Request('http://localhost/api/imported-projects/balance', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: project.id,
            revision: 1,
            wallet,
            walletRevision: 1,
            side: 'Buy',
            amount: '0.000000001',
          }),
        }),
      );
    // Malformed, pre-inventory, and more than 64 slots after inventory.
    for (const nativeSlot of ['1e2', '99', '165']) {
      await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
      mocks.native.mockImplementation(
        solanaChain({ decimals: 9, mintSlot: 100, nativeSlot }),
      );
      expect((await balance()).status).toBe(502);
    }
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    const current = solanaChain({
      decimals: 9,
      mintSlot: 100,
      nativeSlot: '102',
    });
    mocks.native.mockImplementation(current);
    mocks.native.mockImplementationOnce(async (endpoint, method, params) => {
      await mocks.db
        .prepare(
          "UPDATE workspace_wallets SET revision=2,archived=1 WHERE owner_id='alice'",
        )
        .run();
      return current(endpoint, method, params);
    });
    expect((await balance()).status).toBe(409);
  });
  it('checks exact owned project and wallet revisions around fresh balance reads', async () => {
    const { project } = await read(await create());
    const wallet = '11111111111111111111111111111111';
    await mocks.db
      .prepare("INSERT INTO workspace_wallets VALUES ('alice','Solana',?,1,0)")
      .bind(wallet)
      .run();
    const balance = (patch = {}) =>
      balancePOST(
        new Request('http://localhost/api/imported-projects/balance', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: project.id,
            revision: 1,
            wallet,
            walletRevision: 1,
            side: 'Sell',
            amount: '0.000000001',
            ...patch,
          }),
        }),
      );
    mocks.native.mockImplementation(
      solanaChain({ decimals: 9, mintSlot: 100, nativeSlot: '102' }),
    );
    mocks.native.mockClear();
    expect((await balance({ walletRevision: 2 })).status).toBe(409);
    expect(mocks.native).not.toHaveBeenCalled();
    const response = await balance();
    expect(response.status).toBe(200);
    expect(
      (
        (await response.json()) as {
          report: { shortfallRaw: string; executionAllowed: boolean };
        }
      ).report,
    ).toMatchObject({ shortfallRaw: '1', executionAllowed: false });
    expect((await balance()).status).toBe(429);
    await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
    const current = solanaChain({
      decimals: 9,
      mintSlot: 100,
      nativeSlot: '102',
    });
    mocks.native.mockImplementationOnce(async (endpoint, method, params) => {
      await post({ action: 'archive', id: project.id, expectedRevision: 1 });
      return current(endpoint, method, params);
    });
    expect((await balance()).status).toBe(409);
  });
  it('quotes sells using stored mint decimals and rejects client precision overrides', async () => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    mocks.inspect.mockResolvedValueOnce({
      ...token,
      address: mint,
      decimals: 6,
    });
    const { project } = await read(
      await post({ action: 'import', chain: 'Solana', address: mint }),
    );
    const sell = (patch = {}) =>
      quotePOST(
        new Request('http://localhost/api/imported-projects/quote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: project.id,
            revision: 1,
            side: 'Sell',
            amount: '0.000001',
            decimals: 9,
            inputMint: token.address,
            ...patch,
          }),
        }),
      );
    expect((await sell({ amount: '0.0000001' })).status).toBe(400);
    expect((await sell({ side: 'Invalid' })).status).toBe(400);
    expect(mocks.sell).not.toHaveBeenCalled();
    expect((await sell()).status).toBe(503);
    quoteEnv.JUPITER_API_KEY = 'test-key';
    await mocks.db.prepare('DELETE FROM imported_token_project_gates').run();
    expect((await sell()).status).toBe(200);
    expect(mocks.sell.mock.calls[0][0]).toEqual({
      inputMint: mint,
      amount: '0.000001',
      decimals: 6,
    });
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(await count()).toBe(1);
    await mocks.db.prepare('DELETE FROM imported_token_project_gates').run();
    mocks.sell.mockImplementationOnce(async () => {
      await post({ action: 'archive', id: project.id, expectedRevision: 1 });
      return { expiresAt: new Date(Date.now() + 30000).toISOString() };
    });
    expect((await sell()).status).toBe(409);
  });
  it('quotes only the saved contract and rechecks the project revision', async () => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    mocks.inspect.mockResolvedValueOnce({ ...token, address: mint });
    const { project } = await read(
      await post({ action: 'import', chain: 'Solana', address: mint }),
    );
    const quote = () =>
      quotePOST(
        new Request('http://localhost/api/imported-projects/quote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: project.id,
            revision: 1,
            amount: '0.000000001',
            outputMint: token.address,
          }),
        }),
      );
    expect((await quote()).status).toBe(503);
    expect(mocks.quote).not.toHaveBeenCalled();
    quoteEnv.JUPITER_API_KEY = 'test-key';
    await mocks.db.prepare('DELETE FROM imported_token_project_gates').run();
    expect((await quote()).status).toBe(200);
    expect(mocks.quote.mock.calls[0][0]).toEqual({
      outputMint: mint,
      amount: '0.000000001',
    });
    expect((await quote()).status).toBe(429);
    await mocks.db.prepare('DELETE FROM imported_token_project_gates').run();
    mocks.quote.mockImplementationOnce(async () => {
      await post({ action: 'archive', id: project.id, expectedRevision: 1 });
      return { expiresAt: new Date(Date.now() + 30000).toISOString() };
    });
    expect((await quote()).status).toBe(409);
    expect(await count()).toBe(2);
  });
  it('rejects unsupported, stale and invalid buy quote inputs without provider access', async () => {
    const { project } = await read(await create());
    const quote = (patch = {}) =>
      quotePOST(
        new Request('http://localhost/api/imported-projects/quote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: project.id,
            revision: 1,
            amount: '0.01',
            ...patch,
          }),
        }),
      );
    mocks.user = null;
    expect((await quote()).status).toBe(401);
    mocks.user = { userId: 'bob' };
    expect((await quote()).status).toBe(404);
    mocks.user = { userId: 'alice' };
    for (const amount of [
      '0',
      '1e-9',
      '-1',
      '0.0000000001',
      '18446744073.709551616',
    ])
      expect((await quote({ amount })).status).toBe(400);
    expect((await quote({ revision: 2 })).status).toBe(409);
    expect((await quote()).status).toBe(400);
    expect(mocks.quote).not.toHaveBeenCalled();
  });
  it('exposes immutable revision snapshots for active and archived owned projects', async () => {
    const { project } = await read(await create());
    await mocks.db.prepare('DELETE FROM imported_token_project_gates').run();
    mocks.inspect.mockResolvedValueOnce({
      ...token,
      name: 'Updated identity',
      totalSupplyRaw: '1000000000',
    });
    expect(
      (await post({ action: 'refresh', id: project.id, expectedRevision: 1 }))
        .status,
    ).toBe(200);
    expect(
      (await post({ action: 'archive', id: project.id, expectedRevision: 2 }))
        .status,
    ).toBe(200);
    const response = await historyGET(
      new Request(
        `http://localhost/api/imported-projects/events?id=${project.id}`,
      ),
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as {
      events: Array<{
        revision: number;
        type: string;
        document: { token: { name: string; totalSupplyRaw: string } };
      }>;
      nextCursor: string | null;
    };
    expect(body.events.map((event) => event.type)).toEqual([
      'project.archive',
      'project.refresh',
      'project.import',
    ]);
    expect(body.events[0].document.token.name).toBe('Updated identity');
    expect(body.events[2].document.token.totalSupplyRaw).toBe(
      token.totalSupplyRaw,
    );
    expect(body.events[2].document.token.name).toBe(token.name);
    expect(body.nextCursor).toBeNull();
  });
  it('isolates history by owner and validates project and cursor input before storage access', async () => {
    const { project } = await read(await create());
    const history = (suffix = '') =>
      historyGET(
        new Request(
          `http://localhost/api/imported-projects/events?id=${project.id}${suffix}`,
        ),
      );
    mocks.user = null;
    expect((await history()).status).toBe(401);
    mocks.user = { userId: 'bob' };
    expect((await history()).status).toBe(404);
    mocks.user = { userId: 'alice' };
    for (const cursor of [
      '0',
      '-1',
      '1.2',
      '01',
      '9007199254740992',
      'not-a-cursor',
    ])
      expect((await history(`&cursor=${cursor}`)).status).toBe(400);
    expect(
      (
        await historyGET(
          new Request('http://localhost/api/imported-projects/events?id=bad'),
        )
      ).status,
    ).toBe(400);
  });
  it('paginates by revision without duplicates when new revisions arrive', async () => {
    const { project } = await read(await create());
    await mocks.db.batch(
      Array.from({ length: 55 }, (_, index) =>
        mocks.db
          .prepare(
            'INSERT INTO imported_token_project_events(id,owner_id,project_id,type,revision,document,created_at) VALUES (?,?,?,?,?,?,?)',
          )
          .bind(
            crypto.randomUUID(),
            'alice',
            project.id,
            'project.refresh',
            index + 2,
            JSON.stringify(project.document),
            '2026-10-10T08:00:00Z',
          ),
      ),
    );
    await mocks.db
      .prepare(
        'UPDATE imported_token_projects SET revision=56 WHERE owner_id=? AND id=?',
      )
      .bind('alice', project.id)
      .run();
    const history = (suffix = '') =>
      historyGET(
        new Request(
          `http://localhost/api/imported-projects/events?id=${project.id}${suffix}`,
        ),
      );
    const first = (await (await history()).json()) as {
      events: Array<{ revision: number }>;
      nextCursor: string | null;
    };
    expect(first.events).toHaveLength(50);
    expect(first.events[0].revision).toBe(56);
    expect(first.nextCursor).toBe('7');
    await mocks.db
      .prepare(
        'UPDATE imported_token_projects SET revision=57 WHERE owner_id=? AND id=?',
      )
      .bind('alice', project.id)
      .run();
    await mocks.db
      .prepare(
        'INSERT INTO imported_token_project_events(id,owner_id,project_id,type,revision,document,created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .bind(
        crypto.randomUUID(),
        'alice',
        project.id,
        'project.refresh',
        57,
        JSON.stringify(project.document),
        '2026-10-10T08:01:00Z',
      )
      .run();
    const older = (await (await history('&cursor=7')).json()) as {
      revision: number;
      events: Array<{ revision: number }>;
      nextCursor: string | null;
    };
    expect(older.events.map((event) => event.revision)).toEqual([
      6, 5, 4, 3, 2, 1,
    ]);
    expect(older.nextCursor).toBeNull();
    expect(older.revision).toBe(57);
  });
  it('stores only server identity, exact units and sanitized provenance', async () => {
    const response = await create();
    expect(response.status).toBe(200);
    const { project } = await read(response);
    expect(project.document.token.name).toBe('Wrapped SOL');
    expect(project.document.token.totalSupplyRaw).toBe(token.totalSupplyRaw);
    expect(project.document.token.source).toBe('rpc.example.test');
    expect(project.document.token).not.toHaveProperty('metadataUri');
    expect(project.document.executionAllowed).toBe(false);
    expect(project.revision).toBe(1);
    expect(await count()).toBe(1);
    expect((await read(await GET())).projects[0].id).toBe(project.id);
  });
  it('requires auth, same origin and valid bounded source', async () => {
    mocks.user = null;
    expect((await create()).status).toBe(401);
    expect((await GET()).status).toBe(401);
    mocks.user = { userId: 'alice' };
    expect(
      (
        await post(
          { action: 'import', ...token },
          { origin: 'https://other.test' },
        )
      ).status,
    ).toBe(403);
    expect(
      (await post({ action: 'import', chain: 'Solana', address: 'bad' }))
        .status,
    ).toBe(400);
    expect(mocks.inspect).not.toHaveBeenCalled();
  });
  it('isolates owners and refuses duplicate imports without another provider read', async () => {
    const { project } = await read(await create());
    expect((await create()).status).toBe(409);
    expect(mocks.inspect).toHaveBeenCalledTimes(1);
    mocks.user = { userId: 'bob' };
    expect((await read(await GET())).projects).toEqual([]);
    expect(
      (await post({ action: 'archive', id: project.id, expectedRevision: 1 }))
        .status,
    ).toBe(404);
    expect((await create()).status).toBe(200);
    expect(await count()).toBe(2);
  });
  it('archives and restores by revision while preserving fixed token identity', async () => {
    const { project } = await read(await create());
    expect(
      (
        await post({
          action: 'archive',
          id: project.id,
          expectedRevision: 1,
          address: 'bad',
          chain: 'Base',
        })
      ).status,
    ).toBe(200);
    expect(
      (await post({ action: 'restore', id: project.id, expectedRevision: 1 }))
        .status,
    ).toBe(409);
    const { project: restored } = await read(
      await post({ action: 'restore', id: project.id, expectedRevision: 2 }),
    );
    expect(restored.revision).toBe(3);
    expect(restored.archived).toBe(false);
    expect(restored.document.token.address).toBe(token.address);
    expect(mocks.inspect).toHaveBeenCalledTimes(1);
    expect(await count()).toBe(3);
  });
  it('leaves the prior identity intact when refresh fails', async () => {
    const { project } = await read(await create());
    await mocks.db.prepare('DELETE FROM imported_token_project_gates').run();
    mocks.inspect.mockRejectedValue(new Error('Secret provider error'));
    const response = await post({
      action: 'refresh',
      id: project.id,
      expectedRevision: 1,
    });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('Secret');
    const saved = (await read(await GET())).projects[0];
    expect(saved.revision).toBe(1);
    expect(saved.document).toEqual(project.document);
    expect(await count()).toBe(1);
  });
  it('does not overwrite a concurrent archive during a refresh read', async () => {
    const { project } = await read(await create());
    await mocks.db.prepare('DELETE FROM imported_token_project_gates').run();
    mocks.inspect.mockImplementationOnce(async () => {
      expect(
        (await post({ action: 'archive', id: project.id, expectedRevision: 1 }))
          .status,
      ).toBe(200);
      return { ...token, name: 'New name' };
    });
    expect(
      (await post({ action: 'refresh', id: project.id, expectedRevision: 1 }))
        .status,
    ).toBe(409);
    const saved = (await read(await GET())).projects[0];
    expect(saved.archived).toBe(true);
    expect(saved.document.token.name).toBe(token.name);
    expect(await count()).toBe(2);
  });
  it('enforces token-read throttling and handles missing storage', async () => {
    const { project } = await read(await create());
    expect(
      (await post({ action: 'refresh', id: project.id, expectedRevision: 1 }))
        .status,
    ).toBe(429);
    expect(mocks.inspect).toHaveBeenCalledTimes(1);
    const db = mocks.db;
    mocks.db = null as unknown as D1Database;
    try {
      expect((await create()).status).toBe(503);
    } finally {
      mocks.db = db;
    }
  });
  it('atomically enforces the owner project limit without recording a rejected event', async () => {
    await mocks.db
      .prepare(
        "WITH RECURSIVE fixture(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM fixture WHERE n<100) INSERT INTO imported_token_projects(owner_id,id,chain,address,document,mutation_id,updated_at) SELECT 'alice',printf('%08x-0000-4000-8000-000000000000',n),'Base',printf('0x%040x',n),'{}','fixture-'||n,'2026-10-10T08:00:00Z' FROM fixture",
      )
      .run();
    expect((await create()).status).toBe(409);
    expect(await count()).toBe(0);
    expect(
      (await mocks.db
        .prepare('SELECT COUNT(*) AS count FROM imported_token_projects')
        .first<{ count: number }>())!.count,
    ).toBe(100);
  });
  it('rolls back the project write if its revision event cannot be stored', async () => {
    await mocks.db
      .prepare(
        "CREATE TRIGGER reject_import_event BEFORE INSERT ON imported_token_project_events BEGIN SELECT RAISE(ABORT,'test event failure'); END",
      )
      .run();
    try {
      expect((await create()).status).toBe(503);
      expect((await read(await GET())).projects).toEqual([]);
      expect(await count()).toBe(0);
    } finally {
      await mocks.db.prepare('DROP TRIGGER reject_import_event').run();
    }
  });
});

beforeAll(async () => {
  await mocks.db
    .prepare(
      readFileSync(
        new URL(
          '../../../drizzle/0036_imported_pool_candles.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    .run();
});
const candlePool = '11111111111111111111111111111111';
const candleRead = async (project: ImportedTokenProject) => {
  const response = await candlesGET(
    new Request(
      `http://localhost/api/imported-projects/candles?id=${project.id}&revision=${project.revision}`,
    ),
  );
  return {
    status: response.status,
    json: () => response.json() as Promise<{ observations: unknown[] }>,
  };
};
const candleRefresh = (
  project: ImportedTokenProject,
  patch = {},
  headers = {},
) =>
  candlesPOST(
    new Request('http://localhost/api/imported-projects/candles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        id: project.id,
        revision: project.revision,
        pool: candlePool,
        interval: '1h',
        ...patch,
      }),
    }),
  );
const seedCandlePool = async (project: ImportedTokenProject) => {
  await mocks.db
    .prepare('INSERT INTO imported_market_observations VALUES(?,?,?,?)')
    .bind(
      'alice',
      project.id,
      JSON.stringify([{ pairs: [{ address: candlePool }] }]),
      '2026-10-10T18:00:00.000Z',
    )
    .run();
  return {
    chain: token.chain,
    address: token.address,
    pool: candlePool,
    interval: '1h',
    candles: [
      { time: 1791648000, open: 1, high: 2, low: 0.5, close: 1, volume: 100 },
    ],
    source: 'api.geckoterminal.com',
    observedAt: '2026-10-10T18:00:00.000Z',
    executionAllowed: false,
  };
};
it('retains owned candle sets, replaces the same selection and keeps archive access without provider reads', async () => {
  const { project } = await read(await create());
  const snapshot = await seedCandlePool(project);
  expect((await (await candleRead(project)).json()).observations).toEqual([]);
  expect(mocks.candles).not.toHaveBeenCalled();
  expect((await candleRefresh(project, { interval: 'second' })).status).toBe(
    400,
  );
  expect((await candleRefresh(project, { pool: token.address })).status).toBe(
    400,
  );
  expect(mocks.candles).not.toHaveBeenCalled();
  mocks.candles.mockResolvedValue(snapshot);
  expect((await candleRefresh(project)).status).toBe(200);
  expect((await candleRefresh(project)).status).toBe(429);
  expect(mocks.candles).toHaveBeenCalledWith(
    { chain: token.chain, address: token.address },
    candlePool,
    '1h',
    expect.any(AbortSignal),
    fetch,
    undefined,
    'usd',
  );
  mocks.candles.mockClear();
  expect((await (await candleRead(project)).json()).observations).toEqual([
    { ...snapshot, projectRevision: 1 },
  ]);
  expect(mocks.candles).not.toHaveBeenCalled();
  await mocks.db.prepare('DELETE FROM market_read_gates').run();
  mocks.candles.mockResolvedValue({
    ...snapshot,
    observedAt: '2026-10-10T18:00:01.000Z',
  });
  expect((await candleRefresh(project)).status).toBe(200);
  expect((await (await candleRead(project)).json()).observations).toHaveLength(
    1,
  );
  const { project: archived } = await read(
    await post({ action: 'archive', id: project.id, expectedRevision: 1 }),
  );
  expect((await candleRefresh(archived)).status).toBe(409);
  expect((await candleRead(archived)).status).toBe(200);
  mocks.user = { userId: 'bob' };
  expect((await candleRead(archived)).status).toBe(404);
  expect((await candleRefresh(archived)).status).toBe(404);
  mocks.user = null;
  expect((await candleRead(project)).status).toBe(401);
});
it('preserves candles on provider failure and refuses stale versions and cross-origin writes', async () => {
  const { project } = await read(await create());
  const snapshot = await seedCandlePool(project);
  mocks.candles.mockResolvedValue(snapshot);
  expect((await candleRefresh(project)).status).toBe(200);
  const original = await (await candleRead(project)).json();
  await mocks.db.prepare('DELETE FROM market_read_gates').run();
  mocks.candles.mockRejectedValue(new Error('private provider detail'));
  const failed = await candleRefresh(project);
  expect(failed.status).toBe(502);
  expect(await failed.text()).not.toContain('private provider detail');
  expect(await (await candleRead(project)).json()).toEqual(original);
  mocks.candles.mockClear();
  expect((await candleRefresh({ ...project, revision: 2 })).status).toBe(409);
  expect(
    (await candleRefresh(project, {}, { origin: 'https://other.test' })).status,
  ).toBe(403);
  expect(mocks.candles).not.toHaveBeenCalled();
});
it('rejects concurrent market replacement and in-flight archival before saving candles', async () => {
  const { project } = await read(await create());
  const snapshot = await seedCandlePool(project);
  mocks.candles.mockImplementation(async () => {
    await mocks.db
      .prepare('UPDATE imported_market_observations SET document=?')
      .bind('[{"pairs":[]}]')
      .run();
    return snapshot;
  });
  expect((await candleRefresh(project)).status).toBe(409);
  expect((await (await candleRead(project)).json()).observations).toEqual([]);
  await mocks.db
    .prepare('UPDATE imported_market_observations SET document=?')
    .bind(JSON.stringify([{ pairs: [{ address: candlePool }] }]))
    .run();
  await mocks.db.prepare('DELETE FROM market_read_gates').run();
  mocks.candles.mockImplementation(async () => {
    await post({ action: 'archive', id: project.id, expectedRevision: 1 });
    return snapshot;
  });
  expect((await candleRefresh(project)).status).toBe(409);
  expect(
    (await (await candleRead({ ...project, revision: 2 })).json()).observations,
  ).toEqual([]);
});

it('derives older candle cursors from owned saved history, retains latest prices and stops on an empty page', async () => {
  const { project } = await read(await create());
  const snapshot = await seedCandlePool(project);
  expect((await candleRefresh(project, { mode: 'older' })).status).toBe(400);
  expect((await candleRefresh(project, { mode: 'invalid' })).status).toBe(400);
  expect(mocks.candles).not.toHaveBeenCalled();
  mocks.candles.mockResolvedValue(snapshot);
  expect((await candleRefresh(project)).status).toBe(200);
  await mocks.db.prepare('DELETE FROM market_read_gates').run();
  mocks.candles.mockResolvedValue({
    ...snapshot,
    observedAt: '2026-10-10T18:01:00.000Z',
    candles: [
      { ...snapshot.candles[0], time: snapshot.candles[0].time - 7200 },
    ],
  });
  expect(
    (await candleRefresh(project, { mode: 'older', before: 1 })).status,
  ).toBe(200);
  expect(mocks.candles).toHaveBeenLastCalledWith(
    { chain: token.chain, address: token.address },
    candlePool,
    '1h',
    expect.any(AbortSignal),
    fetch,
    snapshot.candles[0].time,
    'usd',
  );
  const saved = (await (await candleRead(project)).json())
    .observations[0] as typeof snapshot & {
    latestObservedAt: string;
    olderExhausted: boolean;
  };
  expect(saved.candles.map((c) => c.time)).toEqual([
    snapshot.candles[0].time - 7200,
    snapshot.candles[0].time,
  ]);
  expect(saved.latestObservedAt).toBe(snapshot.observedAt);
  await mocks.db.prepare('DELETE FROM market_read_gates').run();
  mocks.candles.mockResolvedValue({
    ...snapshot,
    observedAt: '2026-10-10T18:02:00.000Z',
    candles: [],
  });
  expect((await candleRefresh(project, { mode: 'older' })).status).toBe(200);
  expect(
    (await (await candleRead(project)).json()).observations[0],
  ).toMatchObject({ candles: saved.candles, olderExhausted: true });
  mocks.candles.mockClear();
  expect((await candleRefresh(project, { mode: 'older' })).status).toBe(400);
  expect(mocks.candles).not.toHaveBeenCalled();
});

beforeAll(async () => {
  await mocks.db
    .prepare(
      readFileSync(
        new URL(
          '../../../drizzle/0037_imported_pool_trades.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    .run();
});
const tradeRefresh = (project: ImportedTokenProject, patch = {}) =>
  tradesPOST(
    new Request('http://localhost/api/imported-projects/trades', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: project.id,
        revision: project.revision,
        pool: candlePool,
        ...patch,
      }),
    }),
  );
const tradeRead = (project: ImportedTokenProject) =>
  tradesGET(
    new Request(
      `http://localhost/api/imported-projects/trades?id=${project.id}&revision=${project.revision}`,
    ),
  );
it('retains owned pool tapes with saved-only archive access and preserves them on failed provider reads', async () => {
  const { project } = await read(await create());
  await seedCandlePool(project);
  expect((await tradeRead(project)).status).toBe(200);
  expect(mocks.trades).not.toHaveBeenCalled();
  expect((await tradeRefresh(project, { pool: token.address })).status).toBe(
    400,
  );
  const snapshot = {
    chain: token.chain,
    address: token.address,
    pool: candlePool,
    quote: candlePool,
    trades: [],
    returnedCount: 0,
    observedAt: '2026-10-10T19:00:00.000Z',
    source: 'api.geckoterminal.com',
    executionAllowed: false,
  };
  mocks.trades.mockResolvedValue(snapshot);
  expect((await tradeRefresh(project)).status).toBe(200);
  expect((await tradeRefresh(project)).status).toBe(429);
  const original = await (await tradeRead(project)).json();
  await mocks.db.prepare('DELETE FROM market_read_gates').run();
  mocks.trades.mockRejectedValue(new Error('private provider error'));
  const failed = await tradeRefresh(project);
  expect(failed.status).toBe(502);
  expect(await failed.text()).not.toContain('private provider error');
  expect(await (await tradeRead(project)).json()).toEqual(original);
  const { project: archived } = await read(
    await post({
      action: 'archive',
      id: project.id,
      expectedRevision: project.revision,
    }),
  );
  expect((await tradeRefresh(archived)).status).toBe(409);
  expect((await tradeRead(archived)).status).toBe(200);
  mocks.user = { userId: 'bob' };
  expect((await tradeRead(archived)).status).toBe(404);
  expect((await tradeRefresh(archived)).status).toBe(404);
  mocks.user = null;
  expect((await tradeRead(project)).status).toBe(401);
});
it('rejects stale pool tape reads and a project archived while its provider response is in flight', async () => {
  const { project } = await read(await create());
  await seedCandlePool(project);
  expect((await tradeRead({ ...project, revision: 2 })).status).toBe(409);
  mocks.trades.mockImplementation(async () => {
    await post({ action: 'archive', id: project.id, expectedRevision: 1 });
    return {
      chain: token.chain,
      address: token.address,
      pool: candlePool,
      trades: [],
      returnedCount: 0,
      observedAt: '2026-10-10T19:00:00.000Z',
      executionAllowed: false,
    };
  });
  expect((await tradeRefresh(project)).status).toBe(409);
  const saved = (await (
    await tradeRead({ ...project, revision: 2 })
  ).json()) as { observations: unknown[] };
  expect(saved.observations).toEqual([]);
});

beforeAll(async () => {
  await mocks.db
    .prepare(
      readFileSync(
        new URL(
          '../../../drizzle/0038_imported_evm_balances.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    .run();
});
const baseContract = '0x4200000000000000000000000000000000000006',
  baseWallet = '0x1111111111111111111111111111111111111111';
const seedEvmProject = async () => {
  mocks.inspect.mockResolvedValue({
    ...token,
    chain: 'Base',
    address: baseContract,
    decimals: 18,
  });
  const { project } = await read(
    await post({ action: 'import', chain: 'Base', address: baseContract }),
  );
  await mocks.db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?)')
    .bind('alice', 'Base', baseWallet, 1, 0)
    .run();
  return project;
};
const evmRead = (project: ImportedTokenProject) =>
  evmBalanceGET(
    new Request(
      `http://localhost/api/imported-projects/evm-balance?id=${project.id}&revision=${project.revision}`,
    ),
  );
const evmRefresh = (project: ImportedTokenProject, patch = {}) =>
  evmBalancePOST(
    new Request('http://localhost/api/imported-projects/evm-balance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: project.id,
        revision: project.revision,
        wallet: baseWallet,
        walletRevision: 1,
        ...patch,
      }),
    }),
  );
const evmSnapshot = () => ({
  chain: 'Base',
  address: baseWallet,
  holdings: [
    {
      contract: baseContract,
      raw: '123456789123456789',
      decimals: 18,
      amount: '0.123456789123456789',
    },
  ],
  blockNumber: 123,
  blockHash: '0x' + 'a'.repeat(64),
  observedAt: '2026-10-10T20:00:00.000Z',
  source: 'rpc.test',
});
it('binds retained EVM balances to the server-owned project contract, wallet revision and archive state', async () => {
  const project = await seedEvmProject();
  expect((await evmRead(project)).status).toBe(200);
  expect(mocks.evmHoldings).not.toHaveBeenCalled();
  expect((await evmRefresh(project, { walletRevision: 2 })).status).toBe(409);
  mocks.evmHoldings.mockResolvedValue(evmSnapshot());
  expect(
    (
      await evmRefresh(project, {
        contracts: ['0x2222222222222222222222222222222222222222'],
      })
    ).status,
  ).toBe(200);
  expect(mocks.evmHoldings).toHaveBeenCalledWith(
    { chain: 'Base', address: baseWallet, contracts: [baseContract] },
    expect.any(AbortSignal),
  );
  expect((await evmRefresh(project)).status).toBe(429);
  expect(await (await evmRead(project)).json()).toMatchObject({
    observations: [
      { projectRevision: 1, walletRevision: 1, snapshot: evmSnapshot() },
    ],
    executionAllowed: false,
  });
  const { project: archived } = await read(
    await post({ action: 'archive', id: project.id, expectedRevision: 1 }),
  );
  expect((await evmRead(archived)).status).toBe(200);
  expect((await evmRefresh(archived)).status).toBe(409);
  mocks.user = { userId: 'bob' };
  expect((await evmRead(archived)).status).toBe(404);
  expect((await evmRefresh(archived)).status).toBe(404);
  mocks.user = null;
  expect((await evmRead(archived)).status).toBe(401);
});
it('preserves saved project balances on provider failure, mismatched decimals and block regression', async () => {
  const project = await seedEvmProject();
  mocks.evmHoldings.mockResolvedValue(evmSnapshot());
  expect((await evmRefresh(project)).status).toBe(200);
  const saved = await (await evmRead(project)).json();
  await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
  mocks.evmHoldings.mockRejectedValue(new Error('private detail'));
  const failed = await evmRefresh(project);
  expect(failed.status).toBe(502);
  expect(await failed.text()).not.toContain('private detail');
  await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
  mocks.evmHoldings.mockResolvedValue({
    ...evmSnapshot(),
    holdings: [{ ...evmSnapshot().holdings[0], decimals: 6 }],
  });
  expect((await evmRefresh(project)).status).toBe(409);
  await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
  mocks.evmHoldings.mockResolvedValue({ ...evmSnapshot(), blockNumber: 122 });
  expect((await evmRefresh(project)).status).toBe(409);
  expect(await (await evmRead(project)).json()).toEqual(saved);
});
it('rejects EVM wallet changes during project reads before any snapshot can be retained', async () => {
  const project = await seedEvmProject();
  mocks.evmHoldings.mockImplementation(async () => {
    await mocks.db.prepare('UPDATE workspace_wallets SET revision=2').run();
    return evmSnapshot();
  });
  expect((await evmRefresh(project)).status).toBe(409);
  expect(await (await evmRead(project)).json()).toMatchObject({
    observations: [],
  });
});

it('caps EVM project history at 20 wallets and rejects in-flight project archival', async () => {
  const project = await seedEvmProject();
  await mocks.db.batch(
    Array.from({ length: 20 }, (_, i) => {
      const address = '0x' + String(i + 100).padStart(40, '0');
      return mocks.db
        .prepare('INSERT INTO imported_evm_balances VALUES(?,?,?,?,?)')
        .bind(
          'alice',
          project.id,
          address,
          JSON.stringify({
            projectRevision: 1,
            walletRevision: 1,
            snapshot: { ...evmSnapshot(), address },
          }),
          '2026-10-10T19:00:00.000Z',
        );
    }),
  );
  mocks.evmHoldings.mockResolvedValue(evmSnapshot());
  expect((await evmRefresh(project)).status).toBe(409);
  await mocks.db.prepare('DELETE FROM imported_evm_balances').run();
  await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
  mocks.evmHoldings.mockImplementation(async () => {
    await post({ action: 'archive', id: project.id, expectedRevision: 1 });
    return evmSnapshot();
  });
  expect((await evmRefresh(project)).status).toBe(409);
  expect(
    await (await evmRead({ ...project, revision: 2 })).json(),
  ).toMatchObject({ observations: [] });
});
