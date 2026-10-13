import { afterEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { jitoDatabase } from '../test/jito-sqlite';
import { tradeSessionTerms } from './imported-trade-session';
const fixtureEnv = env as unknown as Record<string, string | undefined>;
const mocks = vi.hoisted(() => ({
  balance: vi.fn(),
  prepare: vi.fn(),
  simulate: vi.fn(),
  create: vi.fn(),
  document: '',
}));
vi.mock('./imported-swap-balance', async (original) => ({
  ...(await original<object>()),
  observeImportedSwapBalance: (...args: unknown[]) => mocks.balance(...args),
}));
vi.mock('./warmup-swap-quote', async (original) => ({
  ...(await original<object>()),
  prepareSolanaSwap: (...args: unknown[]) => mocks.prepare(...args),
}));
vi.mock('./imported-swap-simulation', async (original) => {
  const actual = await original<typeof import('./imported-swap-simulation')>();
  return {
    ...actual,
    simulateImportedSwap: (
      ...args: Parameters<typeof actual.simulateImportedSwap>
    ) =>
      args[2] === fetch
        ? mocks.simulate(...args)
        : actual.simulateImportedSwap(...args),
  };
});
vi.mock('./imported-trade-session-server', async (original) => ({
  ...(await original<object>()),
  captureTradeSession: async (
    _db: unknown,
    _owner: string,
    request: { sessionId: string; revision: number; entry: number },
    context: { unitsRaw: string },
  ) => ({
    document: mocks.document,
    controlRevision: 1,
    selection: {
      format: 'trade-session-entry-v1',
      sessionId: request.sessionId,
      sessionRevision: request.revision,
      entry: request.entry,
      termsSha256: 'ab'.repeat(32),
      unitsRaw: context.unitsRaw,
    },
  }),
  currentTradeSession: async (
    _db: unknown,
    _owner: string,
    saved: { document: { session: unknown } },
  ) => ({
    document: mocks.document,
    controlRevision: 1,
    selection: saved.document.session,
  }),
}));
vi.mock('./jito-bundle-server', () => ({
  createJitoBundle: (...args: unknown[]) => mocks.create(...args),
}));
import { prepareJitoBundle } from './jito-bundle-preparation';
const databases: ReturnType<typeof jitoDatabase>[] = [];
afterEach(() => {
  for (const d of databases.splice(0)) d.sqlite.close();
  delete fixtureEnv.JUPITER_API_KEY;
  vi.clearAllMocks();
});
async function fixture() {
  const f = await jitoBundleFixture(4),
    d = jitoDatabase(f.manifest);
  databases.push(d);
  d.sqlite.exec(
    'ALTER TABLE imported_token_projects ADD COLUMN document TEXT; ALTER TABLE imported_trade_sessions ADD COLUMN created_at TEXT; ALTER TABLE imported_trade_sessions ADD COLUMN updated_at TEXT; DELETE FROM imported_swap_signing_intents; DELETE FROM imported_swap_preparations;',
  );
  const token = {
    chain: 'Solana',
    address: f.manifest.swaps[0].outputMint,
    decimals: 6,
  };
  const terms = tradeSessionTerms(
    {
      projectId: f.manifest.projectId,
      projectRevision: 1,
      side: 'Buy',
      entries: f.manifest.swaps.map((r) => ({
        wallet: r.wallet,
        walletRevision: 1,
        amount: '0.001',
      })),
    },
    token,
  );
  mocks.document = JSON.stringify(terms);
  d.sqlite
    .prepare('UPDATE imported_token_projects SET document=?')
    .run(JSON.stringify({ token }));
  d.sqlite
    .prepare(
      'UPDATE imported_trade_sessions SET document=?,created_at=?,updated_at=?',
    )
    .run(mocks.document, f.manifest.createdAt, f.manifest.createdAt);
  fixtureEnv.JUPITER_API_KEY = 'synthetic-test-only';
  mocks.balance.mockImplementation(async (_token: unknown, wallet: string) => ({
    executionAllowed: false,
    wallet,
    side: 'Buy',
    requestedRaw: '1000000',
    mint: token.address,
    amountCovered: true,
    preparationSupported: true,
    observedAt: f.manifest.createdAt,
    expiresAt: f.manifest.expiresAt,
    source: 'fixture',
    nativeSlot: 100,
  }));
  mocks.prepare.mockImplementation(
    async (input: { wallet: string }) =>
      f.swaps.find((s) => s.wallet === input.wallet)!.order,
  );
  mocks.simulate.mockImplementation(
    async (order: { preparation: { wallet: string } }) =>
      f.swaps.find((s) => s.wallet === order.preparation.wallet)!.simulation,
  );
  mocks.create.mockResolvedValue({ state: 'reviewed' });
  const input = {
    projectId: f.manifest.projectId,
    sessionId: f.manifest.sessionId,
    sessionRevision: 1,
    entries: [1, 2, 3, 4],
    tipLamports: '1000',
  };
  return { f, d, input };
}
it('prepares four wallet-bound session entries with strict simulation, without signatures or sends', async () => {
  const { d, input } = await fixture();
  expect(
    await prepareJitoBundle(d.db, 'owner', input, AbortSignal.timeout(1000)),
  ).toEqual({ state: 'reviewed' });
  expect(mocks.balance).toHaveBeenCalledTimes(4);
  expect(mocks.prepare).toHaveBeenCalledTimes(4);
  expect(mocks.simulate).toHaveBeenCalledTimes(4);
  expect(mocks.simulate.mock.calls.every((args) => args[3] === true)).toBe(
    true,
  );
  expect(
    d.sqlite
      .prepare(
        "SELECT count(*) AS n FROM solana_swap_reservations WHERE state='awaiting_signature'",
      )
      .get()?.n,
  ).toBe(4);
  expect(mocks.create.mock.calls[0][2].intentIds).toHaveLength(4);
  expect(mocks.create.mock.calls[0][4]).toBe(true);
});
it('waits for all parallel preparations and cancels only newly created unsigned approvals on a partial failure', async () => {
  const { f, d, input } = await fixture();
  mocks.prepare.mockImplementation(async (value: { wallet: string }) => {
    if (value.wallet === f.swaps[3].wallet)
      throw new Error('Synthetic quote failure');
    return f.swaps.find((s) => s.wallet === value.wallet)!.order;
  });
  await expect(
    prepareJitoBundle(d.db, 'owner', input, AbortSignal.timeout(1000)),
  ).rejects.toThrow('Synthetic quote');
  expect(mocks.create).not.toHaveBeenCalled();
  expect(
    d.sqlite.prepare('SELECT count(*) AS n FROM solana_swap_reservations').get()
      ?.n,
  ).toBe(0);
  expect(
    d.sqlite
      .prepare(
        "SELECT count(*) AS n FROM imported_swap_signing_intents WHERE state='cancelled'",
      )
      .get()?.n,
  ).toBe(3);
});
