import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { readFile } from 'node:fs/promises';
import { createTursoDatabase } from '../db/turso';
import { env } from 'cloudflare:workers';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import { newAutoSellStrategy } from './auto-sell';
import { saveAutoSellProfile } from './auto-sell-profile-storage';
import { type AutoSellProfileTerms } from './auto-sell-profile';
import {
  createOwnedAutoSellRun,
  reserveOwnedAutoSellAttempt,
  startOwnedAutoSellPreparation,
  stopOwnedAutoSellRun,
  type AutoSellRunPreparationGuard,
} from './auto-sell-run-storage';
import { prepareOwnedAutoSellRunAttempt } from './auto-sell-run-preparation';
import { prepareOwnedImportedSwap } from './prepare-owned-imported-swap';
import {
  saveSwapPreparation,
  swapPreparationSummary,
} from './imported-swap-preparation-history';

const mocks = vi.hoisted(() => ({
  balance: vi.fn(),
  prepare: vi.fn(),
  simulate: vi.fn(),
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
      args[2] && args[2] !== fetch
        ? actual.simulateImportedSwap(...args)
        : mocks.simulate(...args),
  };
});

let client: Client, db: D1Database, owner: string;
let fixture: Awaited<ReturnType<typeof nativeWarmupFixture>>;
let run: Awaited<ReturnType<typeof createOwnedAutoSellRun>>;
let attempt: Awaited<ReturnType<typeof reserveOwnedAutoSellAttempt>>;
let balance: Record<string, unknown>;
const signal = () => AbortSignal.timeout(10_000);
const fixtureEnv = env as unknown as Record<string, string | undefined>;
const request = (
  body: unknown = {
    ignored: 'public caller input is not association evidence',
  },
) =>
  new Request('https://bundle.test/internal/unsigned-auto-sell', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://bundle.test',
    },
    body: JSON.stringify(body),
  });
const count = async (table: string) =>
  (
    await client.execute({
      sql: `SELECT count(*) AS n FROM ${table} WHERE owner_id=?`,
      args: [owner],
    })
  ).rows[0].n;
async function stop() {
  return stopOwnedAutoSellRun(
    db,
    owner,
    { id: crypto.randomUUID(), runId: run.id, runSha256: run.sha256 },
    signal(),
  );
}
const prepare = (body?: unknown) =>
  prepareOwnedAutoSellRunAttempt(request(body), owner, db, run.id, attempt.id);
beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = createTursoDatabase(client);
  const journal = JSON.parse(
    await readFile('drizzle/meta/_journal.json', 'utf8'),
  ) as { entries: { tag: string }[] };
  const tags = journal.entries.map((entry) => entry.tag);
  if (!tags.includes('0153_auto_sell_runs')) tags.push('0153_auto_sell_runs');
  for (const tag of tags)
    await client.executeMultiple(
      await readFile('drizzle/' + tag + '.sql', 'utf8'),
    );
});
afterAll(() => client.close());
afterEach(() => {
  delete fixtureEnv.JUPITER_API_KEY;
});
beforeEach(async () => {
  vi.clearAllMocks();
  owner = 'unsigned-adapter-' + crypto.randomUUID();
  fixture = await nativeWarmupFixture({
    side: 'Sell',
    existing: true,
    v2: true,
  });
  const projectId = crypto.randomUUID();
  const token = {
    chain: 'Solana',
    address: fixture.mint,
    name: 'Synthetic token',
    symbol: 'SYN',
    decimals: 6,
    totalSupplyRaw: '1000000000',
    observedAt: new Date().toISOString(),
    source: 'fixture.invalid',
  };
  await client.execute({
    sql: 'INSERT INTO imported_token_projects(owner_id,id,chain,address,document,revision,archived,mutation_id,updated_at) VALUES(?,?,?,?,?,1,0,?,?)',
    args: [
      owner,
      projectId,
      'Solana',
      fixture.mint,
      JSON.stringify({
        format: 'imported-token-project-v1',
        executionAllowed: false,
        token,
      }),
      crypto.randomUUID(),
      new Date().toISOString(),
    ],
  });
  await client.execute({
    sql: 'INSERT INTO workspace_wallets(owner_id,chain,address,folder_id,label,role,archived,revision,updated_at) VALUES(?,?,?,?,?,?,0,1,?)',
    args: [
      owner,
      'Solana',
      fixture.wallet,
      'fixture-folder',
      'Synthetic wallet',
      'Recipient',
      new Date().toISOString(),
    ],
  });
  const terms: AutoSellProfileTerms = {
    name: 'Unsigned journal composition',
    projectId,
    projectRevision: 1,
    token: {
      chain: 'Solana',
      mint: fixture.mint,
      decimals: 6,
      totalSupplyRaw: token.totalSupplyRaw,
    },
    wallets: [{ address: fixture.wallet, revision: 1 }],
    configuration: {
      strategies: [
        {
          ...newAutoSellStrategy(0),
          id: 'dca-one',
          mode: 'dca',
          amountUnit: 'tokens',
          dcaAmount: '0.001',
          dcaIntervalSeconds: 60,
        },
      ],
      session: {
        startDelaySeconds: 0,
        endDurationSeconds: 3600,
        endMaxSupplyPercent: '10',
        maxSlippageBps: 50,
      },
    },
  };
  const profile = await saveAutoSellProfile(
    db,
    owner,
    {
      id: crypto.randomUUID(),
      profileId: crypto.randomUUID(),
      expectedVersion: 0,
      terms,
    },
    signal(),
  );
  run = await createOwnedAutoSellRun(
    db,
    owner,
    {
      id: crypto.randomUUID(),
      projectId,
      profileSaveId: profile.id,
      profileSha256: profile.sha256,
      consent: 'record-auto-sell-run-v1',
    },
    signal(),
  );
  attempt = await reserveOwnedAutoSellAttempt(
    db,
    owner,
    {
      id: crypto.randomUUID(),
      runId: run.id,
      expectedSequence: 0,
      expectedHeadSha256: run.sha256,
      strategyId: 'dca-one',
      wallet: fixture.wallet,
      walletRevision: 1,
      inputRaw: '1000',
      occurrence: { kind: 'dca', index: 0, drawRaw: '1000' },
      consent: 'reserve-auto-sell-attempt-v1',
    },
    signal(),
  );
  balance = {
    executionAllowed: false,
    wallet: fixture.wallet,
    mint: fixture.mint,
    side: 'Sell',
    requestedRaw: '1000',
    amountCovered: true,
    preparationSupported: true,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    source: 'fixture.invalid',
    nativeSlot: 100,
  };
  fixtureEnv.JUPITER_API_KEY = 'synthetic-only-not-a-provider-key';
  mocks.balance.mockReset().mockResolvedValue(balance);
  mocks.prepare.mockReset().mockResolvedValue(fixture.order);
  mocks.simulate.mockReset().mockResolvedValue(fixture.simulation);
});

it('composes the real preparation and writer using the preallocated attempt ID, not caller association data', async () => {
  mocks.balance.mockImplementationOnce(async () => {
    expect(await count('auto_sell_run_preparation_starts')).toBe(1);
    for (const table of [
      'imported_token_project_gates',
      'wallet_balance_gates',
    ]) {
      const gate = (
        await client.execute({
          sql: `SELECT next_allowed_at FROM ${table} WHERE owner_id=?`,
          args: [owner],
        })
      ).rows[0];
      expect(Number(gate.next_allowed_at)).toBeGreaterThan(Date.now());
    }
    return balance;
  });
  const response = await prepare({
    preparationId: 'not-trusted',
    wallet: 'not-trusted',
    amount: '999999',
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    history: {
      id: string;
      document: { inAmountRaw: string; transaction: { sha256: string } };
    };
  };
  expect(body.history.id).toBe(attempt.preparationId);
  expect(body.history.document.inAmountRaw).toBe('1000');
  expect(body.history.document.transaction.sha256).toBe(
    fixture.order.preparation.sha256,
  );
  expect(mocks.balance).toHaveBeenCalledTimes(1);
  expect(mocks.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      wallet: fixture.wallet,
      side: 'Sell',
      amount: '0.001',
      slippageBps: 50,
    }),
    'synthetic-only-not-a-provider-key',
    expect.any(AbortSignal),
  );
  expect(mocks.simulate).toHaveBeenCalledTimes(1);
  expect(await count('auto_sell_run_preparation_starts')).toBe(1);
  expect(await count('imported_swap_preparations')).toBe(1);
  expect(await count('imported_swap_signing_intents')).toBe(0);
});
it('never invokes a provider twice for the same attempt, even after an acknowledged preparation', async () => {
  expect((await prepare()).status).toBe(200);
  expect((await prepare()).status).toBe(409);
  expect(mocks.balance).toHaveBeenCalledTimes(1);
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  expect(await count('imported_swap_preparations')).toBe(1);
});
it('admits at most one provider invocation when two lazy requests race', async () => {
  const responses = await Promise.all([prepare(), prepare()]);
  expect(responses.filter((response) => response.status === 200)).toHaveLength(
    1,
  );
  expect(
    responses.filter((response) => [409, 429].includes(response.status)),
  ).toHaveLength(1);
  expect(mocks.balance).toHaveBeenCalledTimes(1);
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  expect(await count('auto_sell_run_preparation_starts')).toBe(1);
});
it('also refuses reuse of the same internal branded guard before another provider call', async () => {
  const guard = await startOwnedAutoSellPreparation(
    db,
    owner,
    run.id,
    attempt.id,
    signal(),
  );
  const body = {
    id: guard.projectId,
    revision: 1,
    wallet: fixture.wallet,
    walletRevision: 1,
    side: 'Sell',
    amount: '0.001',
    slippageBps: 50,
  };
  expect(
    (
      await prepareOwnedImportedSwap(
        request(body),
        owner,
        db,
        async () => guard,
      )
    ).status,
  ).toBe(200);
  for (const gate of ['imported_token_project_gates', 'wallet_balance_gates'])
    await client.execute({
      sql: `UPDATE ${gate} SET next_allowed_at=0 WHERE owner_id=?`,
      args: [owner],
    });
  expect(
    (
      await prepareOwnedImportedSwap(
        request(body),
        owner,
        db,
        async () => guard,
      )
    ).status,
  ).toBe(409);
  expect(mocks.balance).toHaveBeenCalledTimes(1);
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
});
it('rejects a preclaimed object in place of the server-only lazy callback before any provider', async () => {
  const guard = await startOwnedAutoSellPreparation(
    db,
    owner,
    run.id,
    attempt.id,
    signal(),
  );
  const body = {
    id: guard.projectId,
    revision: 1,
    wallet: fixture.wallet,
    walletRevision: 1,
    side: 'Sell',
    amount: '0.001',
    slippageBps: 50,
  };
  expect(
    (
      await prepareOwnedImportedSwap(
        request(body),
        owner,
        db,
        guard as unknown as () => Promise<AutoSellRunPreparationGuard>,
      )
    ).status,
  ).toBe(409);
  expect(mocks.balance).not.toHaveBeenCalled();
  expect(await count('auto_sell_run_preparation_starts')).toBe(1);
});
it('honors cancellation after a lazy start finishes and before the first provider call', async () => {
  const controller = new AbortController();
  const body = {
    id: run.profile.terms.projectId,
    revision: 1,
    wallet: fixture.wallet,
    walletRevision: 1,
    side: 'Sell',
    amount: '0.001',
    slippageBps: 50,
  };
  const input = new Request(request(body), { signal: controller.signal });
  const lazy = async () => {
    const guard = await startOwnedAutoSellPreparation(
      db,
      owner,
      run.id,
      attempt.id,
      signal(),
    );
    controller.abort();
    return guard;
  };
  expect(
    (await prepareOwnedImportedSwap(input, owner, db, lazy)).status,
  ).not.toBe(200);
  expect(mocks.balance).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(await count('auto_sell_run_preparation_starts')).toBe(1);
  expect(await count('imported_swap_preparations')).toBe(0);
});
it('refuses stopped runs before starting or calling any provider', async () => {
  await stop();
  expect((await prepare()).status).toBe(409);
  expect(mocks.balance).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(await count('auto_sell_run_preparation_starts')).toBe(0);
});
it('refuses publication when stop wins while a provider callback is running', async () => {
  mocks.balance.mockImplementationOnce(async () => {
    await stop();
    return balance;
  });
  expect((await prepare()).status).not.toBe(200);
  expect(await count('auto_sell_run_preparation_starts')).toBe(1);
  expect(await count('imported_swap_preparations')).toBe(0);
  expect(await count('auto_sell_run_attempts')).toBe(1);
});
it('does not consume a start for a missing deterministic provider configuration', async () => {
  delete fixtureEnv.JUPITER_API_KEY;
  expect((await prepare()).status).toBe(503);
  expect(await count('auto_sell_run_preparation_starts')).toBe(0);
  expect(mocks.balance).not.toHaveBeenCalled();
  fixtureEnv.JUPITER_API_KEY = 'synthetic-only-not-a-provider-key';
  expect((await prepare()).status).toBe(200);
  expect(await count('auto_sell_run_preparation_starts')).toBe(1);
  expect(mocks.balance).toHaveBeenCalledTimes(1);
});
it.each(['imported_token_project_gates', 'wallet_balance_gates'] as const)(
  'does not consume a start for a shared 15-second %s refusal',
  async (table) => {
    await client.execute({
      sql: `INSERT INTO ${table}(owner_id,next_allowed_at) VALUES(?,?)`,
      args: [owner, Date.now() + 15_000],
    });
    expect((await prepare()).status).toBe(429);
    expect(await count('auto_sell_run_preparation_starts')).toBe(0);
    expect(mocks.balance).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    // Disposable fixture clocks only: both original admission statements still
    // execute on retry, just as they would after their saved deadlines pass.
    for (const gate of ['imported_token_project_gates', 'wallet_balance_gates'])
      await client.execute({
        sql: `UPDATE ${gate} SET next_allowed_at=0 WHERE owner_id=?`,
        args: [owner],
      });
    expect((await prepare()).status).toBe(200);
    expect(await count('auto_sell_run_preparation_starts')).toBe(1);
    expect(mocks.balance).toHaveBeenCalledTimes(1);
  },
);
it('does not consume a start when ordinary preparation history is full', async () => {
  const document = swapPreparationSummary(
    fixture.order,
    fixture.simulation,
    balance as unknown as Parameters<typeof swapPreparationSummary>[2],
  );
  await client.batch(
    Array.from({ length: 200 }, () => ({
      sql: 'INSERT INTO imported_swap_preparations(id,owner_id,project_id,project_revision,wallet_address,wallet_revision,document,created_at) VALUES(?,?,?,?,?,?,?,?)',
      args: [
        crypto.randomUUID(),
        owner,
        run.profile.terms.projectId,
        1,
        fixture.wallet,
        1,
        JSON.stringify(document),
        new Date().toISOString(),
      ],
    })),
    'write',
  );
  expect((await prepare()).status).toBe(409);
  expect(await count('auto_sell_run_preparation_starts')).toBe(0);
  expect(mocks.balance).not.toHaveBeenCalled();
  // Remove only the 200 ordinary, unbound rows seeded in this disposable test.
  await client.execute({
    sql: 'DELETE FROM imported_swap_preparations WHERE owner_id=?',
    args: [owner],
  });
  expect((await prepare()).status).toBe(200);
  expect(await count('auto_sell_run_preparation_starts')).toBe(1);
  expect(mocks.balance).toHaveBeenCalledTimes(1);
});
it('keeps an unknown provider response irreversible and never starts that attempt twice', async () => {
  mocks.balance.mockRejectedValueOnce(
    Error('Synthetic unknown provider response'),
  );
  expect((await prepare()).status).toBe(502);
  expect(await count('auto_sell_run_preparation_starts')).toBe(1);
  expect((await prepare()).status).toBe(409);
  expect(mocks.balance).toHaveBeenCalledTimes(1);
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it.each([
  'wallet',
  'amount',
  'mint',
  'revision',
  'slippage',
  'session',
] as const)(
  'refuses a mismatched internally bound %s before provider calls',
  async (field) => {
    const guard = await startOwnedAutoSellPreparation(
      db,
      owner,
      run.id,
      attempt.id,
      signal(),
    );
    const body: Record<string, unknown> = {
      id: guard.projectId,
      revision: guard.projectRevision,
      wallet: guard.wallet,
      walletRevision: guard.walletRevision,
      side: 'Sell',
      amount: '0.001',
      slippageBps: 50,
    };
    if (field === 'wallet') body.wallet = '11111111111111111111111111111111';
    if (field === 'amount') body.amount = '0.002';
    if (field === 'revision') body.walletRevision = 2;
    if (field === 'slippage') body.slippageBps = 49;
    if (field === 'session')
      body.session = { sessionId: crypto.randomUUID(), revision: 1, entry: 1 };
    if (field === 'mint')
      await client.execute({
        sql: "UPDATE imported_token_projects SET document=json_set(document,'$.token.address','11111111111111111111111111111111') WHERE owner_id=?",
        args: [owner],
      });
    expect(
      (
        await prepareOwnedImportedSwap(
          request(body),
          owner,
          db,
          async () => guard,
        )
      ).status,
    ).not.toBe(200);
    expect(mocks.balance).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  },
);
it('refuses a deserialized guard even if all public fields look identical', async () => {
  const guard = await startOwnedAutoSellPreparation(
    db,
    owner,
    run.id,
    attempt.id,
    signal(),
  );
  const forged = JSON.parse(
    JSON.stringify(guard),
  ) as AutoSellRunPreparationGuard;
  const response = await prepareOwnedImportedSwap(
    request({
      id: guard.projectId,
      revision: 1,
      wallet: fixture.wallet,
      walletRevision: 1,
      side: 'Sell',
      amount: '0.001',
      slippageBps: 50,
    }),
    owner,
    db,
    async () => forged,
  );
  expect(response.status).not.toBe(200);
  expect(mocks.balance).not.toHaveBeenCalled();
  expect(await count('imported_swap_preparations')).toBe(0);
});
it.each(['wallet', 'amount', 'mint', 'side'] as const)(
  'refuses a final writer document with a different %s',
  async (field) => {
    const guard = await startOwnedAutoSellPreparation(
      db,
      owner,
      run.id,
      attempt.id,
      signal(),
    );
    const document = swapPreparationSummary(
      fixture.order,
      fixture.simulation,
      balance as unknown as Parameters<typeof swapPreparationSummary>[2],
    );
    if (field === 'wallet')
      document.wallet = '11111111111111111111111111111111';
    if (field === 'amount') document.inAmountRaw = '1001';
    if (field === 'mint')
      document.inputMint = '11111111111111111111111111111111';
    if (field === 'side') document.side = 'Buy';
    await expect(
      saveSwapPreparation(
        db,
        owner,
        {
          projectId: guard.projectId,
          projectRevision: 1,
          wallet: guard.wallet,
          walletRevision: 1,
        },
        document,
        undefined,
        undefined,
        undefined,
        guard,
      ),
    ).rejects.toThrow();
    expect(await count('imported_swap_preparations')).toBe(0);
  },
);
it('keeps original order expiry and final source revision checks', async () => {
  mocks.prepare.mockResolvedValueOnce({
    ...fixture.order,
    expiresAt: new Date(Date.now() - 1).toISOString(),
  });
  expect((await prepare()).status).toBe(409);
  expect(mocks.simulate).not.toHaveBeenCalled();
  expect(await count('imported_swap_preparations')).toBe(0);
});
it('refuses changed source after the provider reads without publication', async () => {
  mocks.balance.mockImplementationOnce(async () => {
    await client.execute({
      sql: 'UPDATE workspace_wallets SET revision=revision+1 WHERE owner_id=?',
      args: [owner],
    });
    return balance;
  });
  expect((await prepare()).status).toBe(409);
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(await count('imported_swap_preparations')).toBe(0);
});
it('keeps the ordinary three-argument preparation path outside the run journal', async () => {
  const body = {
    id: run.profile.terms.projectId,
    revision: 1,
    wallet: fixture.wallet,
    walletRevision: 1,
    side: 'Sell',
    amount: '0.001',
    slippageBps: 50,
    // Body fields cannot supply the server-only fourth argument or choose IDs.
    preparationId: attempt.preparationId,
    autoSellRunGuard: { runId: run.id, attemptId: attempt.id },
  };
  const response = await prepareOwnedImportedSwap(request(body), owner, db);
  expect(response.status).toBe(200);
  const value = (await response.json()) as { history: { id: string } };
  expect(value.history.id).not.toBe(attempt.preparationId);
  expect(await count('auto_sell_run_preparation_starts')).toBe(0);
  expect(await count('imported_swap_preparations')).toBe(1);
});
it('refuses cross-origin requests before consuming the one-shot start', async () => {
  const foreign = new Request(
    'https://bundle.test/internal/unsigned-auto-sell',
    {
      method: 'POST',
      headers: { origin: 'https://foreign.test' },
      body: '{}',
    },
  );
  expect(
    (
      await prepareOwnedAutoSellRunAttempt(
        foreign,
        owner,
        db,
        run.id,
        attempt.id,
      )
    ).status,
  ).toBe(403);
  expect(await count('auto_sell_run_preparation_starts')).toBe(0);
  expect(mocks.balance).not.toHaveBeenCalled();
});
it('refuses an already-aborted request before consuming a start or calling providers', async () => {
  const controller = new AbortController();
  controller.abort();
  const aborted = new Request(
    'https://bundle.test/internal/unsigned-auto-sell',
    {
      method: 'POST',
      signal: controller.signal,
      body: '{}',
    },
  );
  expect(
    (
      await prepareOwnedAutoSellRunAttempt(
        aborted,
        owner,
        db,
        run.id,
        attempt.id,
      )
    ).status,
  ).not.toBe(200);
  expect(await count('auto_sell_run_preparation_starts')).toBe(0);
  expect(mocks.balance).not.toHaveBeenCalled();
});
