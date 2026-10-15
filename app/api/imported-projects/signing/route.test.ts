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
import { env } from 'cloudflare:workers';
import { POST as prepareImported } from '../prepare/route';
import { POST, GET } from './route';
import { GET as activity } from '../signing-activity/route';
import { GET as trades } from '../receipts/route';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import { SwapBlockhashExpiredError } from '@/lib/imported-swap-simulation';
let mf: Miniflare;
let f: Awaited<ReturnType<typeof nativeWarmupFixture>>;
const projectId = '11111111-1111-4111-8111-111111111111',
  preparationId = '22222222-2222-4222-8222-222222222222';
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'imported-signing-test',
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
  mocks.db = await mf.getD1Database('DB', 'imported-signing-test');
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
  f = await nativeWarmupFixture({ lookup: true, v2: true });
});
afterAll(async () => {
  await mf?.dispose();
});
async function store(fixture: typeof f) {
  await mocks.db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,?,?,1,0,?,?)')
    .bind(
      'alice',
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
    .bind('alice', 'Solana', fixture.wallet, 1)
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
      'alice',
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
  mocks.user = { userId: 'alice' };
  (env as unknown as Record<string, string>).JUPITER_API_KEY =
    'isolated-test-only';
  mocks.prepare.mockReset();
  mocks.balance.mockReset();
  // IF EXISTS: a test that fails after dropping a trigger must not cascade into later tests.
  await mocks.db
    .prepare(
      'DROP TRIGGER IF EXISTS imported_swap_signing_events_immutable_delete',
    )
    .run();
  await mocks.db.prepare('DELETE FROM imported_swap_signing_events').run();
  await mocks.db
    .prepare(
      "CREATE TRIGGER imported_swap_signing_events_immutable_delete BEFORE DELETE ON imported_swap_signing_events BEGIN SELECT RAISE(ABORT,'Imported signing event is immutable'); END",
    )
    .run();
  await mocks.db
    .prepare('DROP TRIGGER IF EXISTS imported_trade_lot_links_immutable_delete')
    .run();
  await mocks.db.prepare('DELETE FROM imported_trade_lot_links').run();
  await mocks.db
    .prepare(
      "CREATE TRIGGER imported_trade_lot_links_immutable_delete BEFORE DELETE ON imported_trade_lot_links BEGIN SELECT RAISE(ABORT,'Acquisition link is immutable'); END",
    )
    .run();
  await mocks.db.prepare('DELETE FROM imported_trade_lot_gates').run();
  for (const table of [
    'imported_swap_signing_intents',
    'warmup_signing_intents',
    'imported_swap_receipts',
    'solana_swap_reservations',
    'solana_swap_signatures',
    'solana_execution_reservations',
    'solana_execution_signatures',
    'imported_token_projects',
    'imported_swap_preparations',
    'workspace_wallets',
    'wallet_balance_gates',
    'imported_token_project_gates',
  ])
    await mocks.db.prepare(`DELETE FROM ${table}`).run();
  f = await nativeWarmupFixture({ lookup: true, v2: true });
  await store(f);
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
const post = (body: object, headers = {}) =>
  POST(
    new Request('http://localhost/api/imported-projects/signing', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
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
  return ((await response.json()) as { review: { id: string } }).review.id;
}
const reserved = () =>
  mocks.db
    .prepare(
      'SELECT scope,state FROM solana_swap_reservations WHERE owner_id=? AND wallet_address=?',
    )
    .bind('alice', f.wallet)
    .first();
it('reserves one wallet across warmup and imported approvals, including INSERT OR IGNORE and reactivation', async () => {
  const id = await reviewed();
  expect(await reserved()).toEqual({
    scope: 'imported',
    state: 'awaiting_signature',
  });
  const warmupId = crypto.randomUUID();
  const insert = () =>
    mocks.db
      .prepare(
        "INSERT OR IGNORE INTO warmup_signing_intents VALUES(?,?,?,?,?,'awaiting_signature',NULL,?,?)",
      )
      .bind(
        warmupId,
        'alice',
        crypto.randomUUID(),
        f.wallet,
        '{}',
        'now',
        'now',
      )
      .run();
  await expect(insert()).rejects.toThrow('Wallet already reserved');
  expect((await post({ action: 'cancel', id })).status).toBe(200);
  expect(await reserved()).toBeNull();
  await insert();
  expect(await reserved()).toEqual({
    scope: 'warmup',
    state: 'awaiting_signature',
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
  await expect(
    mocks.db
      .prepare(
        "UPDATE imported_swap_signing_intents SET state='signed' WHERE id=?",
      )
      .bind(id)
      .run(),
  ).rejects.toThrow('Wallet already reserved');
  expect(
    await mocks.db
      .prepare('SELECT state FROM imported_swap_signing_intents WHERE id=?')
      .bind(id)
      .first(),
  ).toEqual({ state: 'cancelled' });
});
it.each([
  { side: 'Buy' as const, token2022: false },
  { side: 'Sell' as const, token2022: false },
  { side: 'Buy' as const, token2022: true },
  { side: 'Sell' as const, token2022: true },
])(
  'registers and submits $side once (Token-2022 $token2022), then atomically recovers the exact finalized receipt across archives',
  async ({ side, token2022 }) => {
    if (side === 'Sell' || token2022) {
      for (const table of [
        'imported_token_projects',
        'imported_swap_preparations',
        'workspace_wallets',
      ])
        await mocks.db.prepare(`DELETE FROM ${table}`).run();
      f = await nativeWarmupFixture({
        side,
        lookup: true,
        v2: true,
        token2022,
      });
      await store(f);
      mocks.simulate.mockResolvedValue(f.simulation);
    }
    const id = await reviewed();
    expect(
      (await post({ action: 'submit', id, transaction: f.signed.transaction }))
        .status,
    ).toBe(409);
    expect(
      (
        await post({
          action: 'register',
          id,
          transaction: f.signed.transaction,
        })
      ).status,
    ).toBe(200);
    expect(await reserved()).toEqual({ scope: 'imported', state: 'signed' });
    expect((await post({ action: 'cancel', id })).status).toBe(409);
    expect(
      (await post({ action: 'submit', id, transaction: f.signed.transaction }))
        .status,
    ).toBe(200);
    expect(
      (await post({ action: 'submit', id, transaction: f.signed.transaction }))
        .status,
    ).toBe(409);
    expect(
      mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
    ).toHaveLength(1);
    await mocks.db
      .prepare('UPDATE imported_token_projects SET archived=1,revision=2')
      .run();
    const recovered = await post({ action: 'recover', id });
    expect(recovered.status).toBe(200);
    const value = (await recovered.json()) as {
      state: string;
      receipt: { id: string; document: Record<string, unknown> };
    };
    expect(value.state).toBe('finalized');
    expect(value.receipt.document).toMatchObject({
      side,
      signature: f.signed.signature,
      signatureVerified: true,
      commitment: 'finalized',
      tokenUnitsRaw: expect.any(String),
    });
    await mocks.db
      .prepare('UPDATE imported_token_projects SET document=? WHERE id=?')
      .bind(
        JSON.stringify({
          token: {
            chain: 'Solana',
            address: value.receipt.document.mint,
            decimals: value.receipt.document.decimals,
          },
        }),
        projectId,
      )
      .run();
    const ledgerResponse = await trades(
      new Request(
        `http://localhost/api/imported-projects/receipts?projectId=${projectId}`,
      ),
    );
    expect(ledgerResponse.status).toBe(200);
    const ledger = (await ledgerResponse.json()) as {
      receipts: { document: Record<string, unknown> }[];
      summary: { receiptCount: number; networkFeeLamports: string };
      nextCursor: null;
    };
    expect(ledger.receipts).toHaveLength(1);
    expect(ledger.receipts[0].document).toMatchObject({
      side,
      signature: f.signed.signature,
      tokenUnitsRaw: value.receipt.document.tokenUnitsRaw,
    });
    expect(ledger.summary).toMatchObject({
      receiptCount: 1,
      networkFeeLamports: value.receipt.document.networkFeeLamports,
    });
    expect(ledger.nextCursor).toBeNull();
    const csv = await trades(
      new Request(
        `http://localhost/api/imported-projects/receipts?projectId=${projectId}&format=csv`,
      ),
    );
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(await csv.text()).toContain(f.signed.signature);
    const history = await eventRows();
    expect(history.map((row) => row.type)).toEqual([
      'approval.reviewed',
      'approval.signed',
      'approval.submission_started',
      'approval.finalized',
    ]);
    expect(
      history.every(
        (row) =>
          row.project_id === projectId &&
          row.project_revision === 1 &&
          row.wallet_revision === 1,
      ),
    ).toBe(true);
    expect(
      history.slice(1).every((row) => row.signature === f.signed.signature),
    ).toBe(true);
    expect(await reserved()).toBeNull();
    const again = await post({ action: 'recover', id });
    expect(((await again.json()) as typeof value).receipt.id).toBe(
      value.receipt.id,
    );
    expect(await eventRows()).toHaveLength(4);
    expect(
      await mocks.db
        .prepare('SELECT COUNT(*) AS n FROM imported_swap_receipts')
        .first(),
    ).toEqual({ n: 1 });
    mocks.user = { userId: 'bob' };
    expect(
      (
        await trades(
          new Request(
            `http://localhost/api/imported-projects/receipts?projectId=${projectId}`,
          ),
        )
      ).status,
    ).toBe(404);
    expect((await post({ action: 'recover', id })).status).toBe(404);
    expect(
      (
        await GET(
          new Request(
            `http://localhost/api/imported-projects/signing?projectId=${projectId}`,
          ),
        )
      ).status,
    ).toBe(404);
  },
);
it('retains an unknown send outcome and only releases a failed reservation after exact finalized packet verification', async () => {
  const id = await reviewed();
  await post({ action: 'register', id, transaction: f.signed.transaction });
  mocks.rpc.mockImplementation(async (_endpoint, method) => {
    if (method === 'sendTransaction') throw new Error('timeout');
    return method === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : null;
  });
  const sent = await post({
    action: 'submit',
    id,
    transaction: f.signed.transaction,
  });
  expect(sent.status).toBe(502);
  expect(await reserved()).toEqual({ scope: 'imported', state: 'submitted' });
  expect(
    (await post({ action: 'submit', id, transaction: f.signed.transaction }))
      .status,
  ).toBe(409);
  expect((await post({ action: 'recover', id })).status).toBe(409);
  mocks.rpc.mockImplementation(async (_endpoint, method) =>
    method === 'getGenesisHash'
      ? SOLANA_MAINNET_GENESIS
      : {
          ...f.receipt,
          meta: {
            ...f.receipt.meta,
            err: { InstructionError: [0, 'InsufficientFunds'] },
            postBalances: f.receipt.meta.preBalances.map((v, i) =>
              i === 0 ? (BigInt(v) - 5000n).toString() : v,
            ),
          },
        },
  );
  const failed = await post({ action: 'recover', id });
  expect(failed.status).toBe(200);
  expect(await failed.json()).toMatchObject({ state: 'failed' });
  expect((await eventRows()).map((row) => row.type)).toEqual([
    'approval.reviewed',
    'approval.signed',
    'approval.submission_started',
    'approval.failed',
  ]);
  expect(await reserved()).toBeNull();
});
it('keeps registered signatures reserved when lookup fingerprints, blockhash or project context change before sending', async () => {
  const id = await reviewed();
  await post({ action: 'register', id, transaction: f.signed.transaction });
  const lookup = f.simulation.lookupObservation!;
  mocks.simulate.mockResolvedValueOnce({
    ...f.simulation,
    lookupObservation: {
      ...lookup,
      tables: lookup.tables.map((t) => ({ ...t, sha256: 'a'.repeat(64) })),
    },
  });
  expect(
    (await post({ action: 'submit', id, transaction: f.signed.transaction }))
      .status,
  ).toBe(409);
  mocks.simulate.mockRejectedValueOnce(new SwapBlockhashExpiredError());
  expect(
    (await post({ action: 'submit', id, transaction: f.signed.transaction }))
      .status,
  ).toBe(409);
  mocks.simulate.mockImplementationOnce(async () => {
    await mocks.db
      .prepare('UPDATE imported_token_projects SET revision=2')
      .run();
    return f.simulation;
  });
  expect(
    (await post({ action: 'submit', id, transaction: f.signed.transaction }))
      .status,
  ).toBe(409);
  expect(await reserved()).toEqual({ scope: 'imported', state: 'signed' });
  expect(
    mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
  ).toHaveLength(0);
});
it('rolls back both receipt and reservation finalization if receipt storage fails', async () => {
  const id = await reviewed();
  await post({ action: 'register', id, transaction: f.signed.transaction });
  await mocks.db
    .prepare(
      "CREATE TRIGGER receipt_reject AFTER INSERT ON imported_swap_receipts BEGIN SELECT RAISE(ABORT,'test storage failure'); END",
    )
    .run();
  expect((await post({ action: 'recover', id })).status).toBe(502);
  expect(await reserved()).toEqual({ scope: 'imported', state: 'signed' });
  expect(
    await mocks.db
      .prepare('SELECT COUNT(*) AS n FROM imported_swap_receipts')
      .first(),
  ).toEqual({ n: 0 });
  await mocks.db.prepare('DROP TRIGGER receipt_reject').run();
  expect((await post({ action: 'recover', id })).status).toBe(200);
  expect(await reserved()).toBeNull();
});
it('makes approved context and registered signatures immutable and deduplicates signatures across scopes', async () => {
  const id = await reviewed();
  await post({ action: 'register', id, transaction: f.signed.transaction });
  await expect(
    mocks.db
      .prepare(
        "UPDATE imported_swap_signing_intents SET document='{}' WHERE id=?",
      )
      .bind(id)
      .run(),
  ).rejects.toThrow('immutable');
  await expect(
    mocks.db
      .prepare(
        'UPDATE imported_swap_signing_intents SET signature=NULL WHERE id=?',
      )
      .bind(id)
      .run(),
  ).rejects.toThrow('immutable');
  await post({ action: 'recover', id });
  await expect(
    mocks.db
      .prepare(
        "INSERT OR IGNORE INTO warmup_signing_intents VALUES(?,?,?,?,?,'signed',?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        'alice',
        crypto.randomUUID(),
        f.wallet,
        '{}',
        f.signed.signature,
        'now',
        'now',
      )
      .run(),
  ).rejects.toThrow('Signature already registered');
  expect(await reserved()).toBeNull();
});
it('paginates retained approvals across archives with project and owner bound cursors', async () => {
  const id = await reviewed();
  const captured = await mocks.db
    .prepare('SELECT document FROM imported_swap_signing_intents WHERE id=?')
    .bind(id)
    .first<{ document: string }>();
  await post({ action: 'cancel', id });
  const review = JSON.parse(captured!.document);
  for (let index = 0; index < 50; index++) {
    const prep = crypto.randomUUID(),
      intent = crypto.randomUUID(),
      created = new Date(Date.now() + index * 1000).toISOString();
    await mocks.db
      .prepare(
        'INSERT INTO imported_swap_preparations SELECT ?,owner_id,project_id,project_revision,wallet_address,wallet_revision,document,? FROM imported_swap_preparations WHERE id=?',
      )
      .bind(prep, created, preparationId)
      .run();
    await mocks.db
      .prepare(
        "INSERT INTO imported_swap_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,signature,created_at,updated_at) VALUES(?,?,?,?,?,'cancelled',NULL,?,?)",
      )
      .bind(
        intent,
        'alice',
        prep,
        f.wallet,
        JSON.stringify({ ...review, id: intent, preparationId: prep }),
        created,
        created,
      )
      .run();
  }
  await mocks.db
    .prepare('UPDATE imported_token_projects SET archived=1,revision=2')
    .run();
  const first = await GET(
    new Request(
      `http://localhost/api/imported-projects/signing?projectId=${projectId}`,
    ),
  );
  expect(first.status).toBe(200);
  const page = (await first.json()) as {
    intents: { id: string }[];
    nextCursor: string;
  };
  expect(page.intents).toHaveLength(50);
  const second = await GET(
    new Request(
      `http://localhost/api/imported-projects/signing?projectId=${projectId}&cursor=${page.nextCursor}`,
    ),
  );
  const older = (await second.json()) as {
    intents: { id: string }[];
    nextCursor: null;
  };
  expect(second.status).toBe(200);
  expect(older.intents).toHaveLength(1);
  expect(older.nextCursor).toBeNull();
  expect(page.intents.some((row) => row.id === older.intents[0].id)).toBe(
    false,
  );
  expect(
    (
      await GET(
        new Request(
          `http://localhost/api/imported-projects/signing?projectId=${projectId}&cursor=${crypto.randomUUID()}`,
        ),
      )
    ).status,
  ).toBe(400);
  mocks.user = { userId: 'bob' };
  expect(
    (
      await GET(
        new Request(
          `http://localhost/api/imported-projects/signing?projectId=${projectId}&cursor=${page.nextCursor}`,
        ),
      )
    ).status,
  ).toBe(404);
});

async function eventRows() {
  return (
    await mocks.db
      .prepare(
        'SELECT type,state,signature,project_id,project_revision,wallet_revision FROM imported_swap_signing_events ORDER BY sequence',
      )
      .all<{
        type: string;
        state: string;
        signature: string | null;
        project_id: string;
        project_revision: number;
        wallet_revision: number;
      }>()
  ).results;
}
const activityRequest = (query = '') =>
  activity(
    new Request(
      `http://localhost/api/imported-projects/signing-activity${query}`,
    ),
  );
it('rolls back review, signature registration, submission and finalized receipts when event persistence fails', async () => {
  const reject = async (type: string) =>
    mocks.db
      .prepare(
        `CREATE TRIGGER event_reject BEFORE INSERT ON imported_swap_signing_events WHEN NEW.type='${type}' BEGIN SELECT RAISE(ABORT,'test event failure'); END`,
      )
      .run();
  const restore = async () =>
    mocks.db.prepare('DROP TRIGGER event_reject').run();
  await reject('approval.reviewed');
  expect(
    (
      await post({
        action: 'review',
        preparationId,
        transaction: f.order.preparation.transaction,
      })
    ).status,
  ).not.toBe(200);
  expect(await reserved()).toBeNull();
  expect(await eventRows()).toHaveLength(0);
  expect(
    await mocks.db
      .prepare('SELECT COUNT(*) AS n FROM imported_swap_signing_intents')
      .first(),
  ).toEqual({ n: 0 });
  await restore();
  await mocks.db.prepare('DELETE FROM wallet_balance_gates').run();
  const id = await reviewed();
  await reject('approval.signed');
  expect(
    (await post({ action: 'register', id, transaction: f.signed.transaction }))
      .status,
  ).not.toBe(200);
  expect(await reserved()).toEqual({
    scope: 'imported',
    state: 'awaiting_signature',
  });
  expect(
    await mocks.db
      .prepare('SELECT COUNT(*) AS n FROM solana_swap_signatures')
      .first(),
  ).toEqual({ n: 0 });
  await restore();
  expect(
    (await post({ action: 'register', id, transaction: f.signed.transaction }))
      .status,
  ).toBe(200);
  await reject('approval.submission_started');
  expect(
    (await post({ action: 'submit', id, transaction: f.signed.transaction }))
      .status,
  ).not.toBe(200);
  expect(await reserved()).toEqual({ scope: 'imported', state: 'signed' });
  expect(
    mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
  ).toHaveLength(0);
  await restore();
  await reject('approval.finalized');
  expect((await post({ action: 'recover', id })).status).not.toBe(200);
  expect(await reserved()).toEqual({ scope: 'imported', state: 'signed' });
  expect(
    await mocks.db
      .prepare('SELECT COUNT(*) AS n FROM imported_swap_receipts')
      .first(),
  ).toEqual({ n: 0 });
  expect((await eventRows()).map((row) => row.type)).toEqual([
    'approval.reviewed',
    'approval.signed',
  ]);
  await restore();
  expect((await post({ action: 'recover', id })).status).toBe(200);
  expect(await reserved()).toBeNull();
});
it('keeps immutable captured context readable after archive and separates cancelled approval from execution', async () => {
  const id = await reviewed();
  expect((await post({ action: 'cancel', id })).status).toBe(200);
  await mocks.db
    .prepare('UPDATE imported_token_projects SET archived=1,revision=9')
    .run();
  await expect(
    mocks.db
      .prepare("UPDATE imported_swap_signing_events SET state='finalized'")
      .run(),
  ).rejects.toThrow('immutable');
  await expect(
    mocks.db.prepare('DELETE FROM imported_swap_signing_events').run(),
  ).rejects.toThrow('immutable');
  const response = await activityRequest(`?projectId=${projectId}`);
  expect(response.status).toBe(200);
  const value = (await response.json()) as {
    events: {
      type: string;
      projectRevision: number;
      walletRevision: number;
      signature: null;
      document: object;
    }[];
  };
  expect(value.events.map((row) => row.type)).toEqual([
    'approval.cancelled',
    'approval.reviewed',
  ]);
  expect(
    value.events.every(
      (row) =>
        row.projectRevision === 1 &&
        row.walletRevision === 1 &&
        row.signature === null,
    ),
  ).toBe(true);
  expect(JSON.stringify(value)).not.toContain(f.order.preparation.transaction);
  await mocks.db.prepare('DELETE FROM imported_swap_signing_intents').run();
  await mocks.db.prepare('DELETE FROM imported_swap_preparations').run();
  expect(
    ((await (await activityRequest()).json()) as { events: unknown[] }).events,
  ).toHaveLength(2);
  mocks.user = { userId: 'bob' };
  expect(
    ((await (await activityRequest()).json()) as { events: unknown[] }).events,
  ).toEqual([]);
  expect((await activityRequest(`?projectId=${projectId}`)).status).toBe(404);
  mocks.user = null;
  expect((await activityRequest()).status).toBe(401);
});
it('paginates equal timestamps without duplicates and binds cursors to owner and project', async () => {
  const id = await reviewed();
  const captured = await mocks.db
    .prepare('SELECT document FROM imported_swap_signing_intents WHERE id=?')
    .bind(id)
    .first<{ document: string }>();
  await post({ action: 'cancel', id });
  const review = JSON.parse(captured!.document);
  for (let index = 0; index < 51; index++) {
    const intent = crypto.randomUUID();
    const prep = crypto.randomUUID();
    await mocks.db
      .prepare(
        'INSERT INTO imported_swap_preparations SELECT ?,owner_id,project_id,project_revision,wallet_address,wallet_revision,document,created_at FROM imported_swap_preparations WHERE id=?',
      )
      .bind(prep, preparationId)
      .run();
    await mocks.db
      .prepare(
        "INSERT INTO imported_swap_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,signature,created_at,updated_at) VALUES(?,?,?,?,?,'cancelled',NULL,?,?)",
      )
      .bind(
        intent,
        'alice',
        prep,
        f.wallet,
        JSON.stringify({ ...review, id: intent, preparationId: prep }),
        '2030-01-01T00:00:00.000Z',
        '2030-01-01T00:00:00.000Z',
      )
      .run();
  }
  const first = await activityRequest(`?projectId=${projectId}`);
  expect(first.status).toBe(200);
  const page = (await first.json()) as {
    events: { id: string; type: string }[];
    nextCursor: string;
  };
  expect(page.events).toHaveLength(50);
  expect(page.events.every((row) => row.type === 'approval.baseline')).toBe(
    true,
  );
  const second = await activityRequest(
    `?projectId=${projectId}&cursor=${page.nextCursor}`,
  );
  const older = (await second.json()) as typeof page;
  expect(second.status).toBe(200);
  expect(older.events).toHaveLength(3);
  expect(older.nextCursor).toBeNull();
  expect(
    new Set([...page.events, ...older.events].map((row) => row.id)).size,
  ).toBe(53);
  expect((await activityRequest('?cursor=bad')).status).toBe(400);
  expect((await activityRequest(`?cursor=${'f'.repeat(32)}`)).status).toBe(400);
  const otherProject = crypto.randomUUID();
  await mocks.db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,?,?,1,0,?,?)')
    .bind(
      'alice',
      otherProject,
      'Solana',
      f.wallet,
      '{}',
      crypto.randomUUID(),
      new Date().toISOString(),
    )
    .run();
  expect(
    (
      await activityRequest(
        `?projectId=${otherProject}&cursor=${page.nextCursor}`,
      )
    ).status,
  ).toBe(400);
  mocks.user = { userId: 'bob' };
  expect((await activityRequest(`?cursor=${page.nextCursor}`)).status).toBe(
    400,
  );
});

it('returns an honest empty ledger, validates cursors and refuses malformed retained settlement totals', async () => {
  await mocks.db
    .prepare('UPDATE imported_token_projects SET document=? WHERE id=?')
    .bind(
      JSON.stringify({
        token: { chain: 'Solana', address: f.mint, decimals: 6 },
      }),
      projectId,
    )
    .run();
  const request = (extra = '') =>
    trades(
      new Request(
        `http://localhost/api/imported-projects/receipts?projectId=${projectId}${extra}`,
      ),
    );
  const empty = await request();
  expect(empty.status).toBe(200);
  expect(await empty.json()).toMatchObject({
    receipts: [],
    nextCursor: null,
    summary: { receiptCount: 0, solSpentRaw: '0', solReceivedRaw: '0' },
  });
  expect((await request(`&cursor=${crypto.randomUUID()}`)).status).toBe(400);
  expect(
    (await request('&format=csv&cursor=' + crypto.randomUUID())).status,
  ).toBe(400);
  const id = await reviewed();
  await post({ action: 'register', id, transaction: f.signed.transaction });
  const recovered = await post({ action: 'recover', id });
  expect(recovered.status).toBe(200);
  const value = (await recovered.json()) as {
    receipt: { document: { mint: string; decimals: number } };
  };
  await mocks.db
    .prepare('UPDATE imported_token_projects SET document=? WHERE id=?')
    .bind(
      JSON.stringify({
        token: {
          chain: 'Solana',
          address: value.receipt.document.mint,
          decimals: value.receipt.document.decimals,
        },
      }),
      projectId,
    )
    .run();
  expect((await request()).status).toBe(200);
  await mocks.db
    .prepare(
      "UPDATE imported_swap_receipts SET document=json_set(document,'$.networkFeeLamports','1.5')",
    )
    .run();
  const malformed = await request();
  expect(malformed.status).toBe(503);
  expect(await malformed.json()).not.toHaveProperty('summary');
  expect((await request('&format=csv')).status).toBe(503);
});

it('paginates retained receipt fixtures at equal timestamps and keeps totals independent of loaded pages', async () => {
  const id = await reviewed();
  await post({ action: 'register', id, transaction: f.signed.transaction });
  const recovered = await post({ action: 'recover', id });
  expect(recovered.status).toBe(200);
  const actual = (await recovered.json()) as {
    receipt: {
      document: {
        mint: string;
        decimals: number;
        networkFeeLamports: string;
        tokenUnitsRaw: string;
        [key: string]: unknown;
      };
    };
  };
  await mocks.db
    .prepare(
      'UPDATE imported_token_projects SET document=?,archived=1,revision=9 WHERE id=?',
    )
    .bind(
      JSON.stringify({
        token: {
          chain: 'Solana',
          address: actual.receipt.document.mint,
          decimals: actual.receipt.document.decimals,
        },
      }),
      projectId,
    )
    .run();
  const { default: bs58 } = await import('bs58');
  for (let i = 0; i < 51; i++) {
    const signature = bs58.encode(crypto.getRandomValues(new Uint8Array(64))),
      document = { ...actual.receipt.document, signature };
    await mocks.db
      .prepare(
        'INSERT INTO imported_swap_receipts SELECT ?,owner_id,?,preparation_id,project_id,project_revision,wallet_revision,?,?,? FROM imported_swap_receipts LIMIT 1',
      )
      .bind(
        crypto.randomUUID(),
        crypto.randomUUID(),
        signature,
        JSON.stringify(document),
        '2030-01-01T00:00:00.000Z',
      )
      .run();
  }
  const request = (suffix = '') =>
    trades(
      new Request(
        `http://localhost/api/imported-projects/receipts?projectId=${projectId}${suffix}`,
      ),
    );
  const first = await request();
  expect(first.status).toBe(200);
  const page = (await first.json()) as {
    receipts: { id: string }[];
    summary: { receiptCount: number; networkFeeLamports: string };
    nextCursor: string;
  };
  expect(page.receipts).toHaveLength(50);
  expect(page.summary.receiptCount).toBe(52);
  expect(page.summary.networkFeeLamports).toBe(
    (BigInt(actual.receipt.document.networkFeeLamports) * 52n).toString(),
  );
  const next = await request('&cursor=' + page.nextCursor);
  expect(next.status).toBe(200);
  const older = (await next.json()) as typeof page;
  expect(older.receipts).toHaveLength(2);
  expect(older.nextCursor).toBeNull();
  expect(older.summary).toEqual(page.summary);
  expect(
    new Set([...page.receipts, ...older.receipts].map((row) => row.id)).size,
  ).toBe(52);
  const csv = await request('&format=csv');
  expect(csv.status).toBe(200);
  expect((await csv.text()).split('\r\n')).toHaveLength(54);
  mocks.user = { userId: 'bob' };
  expect((await request('&cursor=' + page.nextCursor)).status).toBe(404);
}, 20000);

it('backfills archived failed cost as a new captured event, preserves history and freezes evidence without resending', async () => {
  const id = await reviewed();
  await post({ action: 'register', id, transaction: f.signed.transaction });
  await mocks.db
    .prepare(
      "UPDATE imported_swap_signing_intents SET state='failed',updated_at=? WHERE id=?",
    )
    .bind(new Date().toISOString(), id)
    .run();
  await mocks.db.prepare('UPDATE imported_token_projects SET archived=1').run();
  await mocks.db.prepare('UPDATE workspace_wallets SET archived=1').run();
  const raw = {
    ...f.receipt,
    meta: {
      ...f.receipt.meta,
      postBalances: f.receipt.meta.preBalances.map((v, i) =>
        i === 0 ? (BigInt(v) - 5000n).toString() : v,
      ),
      err: { InstructionError: ['0', { Custom: '42' }] },
    },
  };
  mocks.rpc.mockImplementation(async (_endpoint, method) =>
    method === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : raw,
  );
  const before = (await (await activityRequest()).json()) as {
    events: import('@/lib/imported-signing-events').ImportedSigningEvent[];
  };
  const response = await post({ action: 'recover', id });
  expect(response.status).toBe(200);
  const result = (await response.json()) as {
    failureReceipt: import('@/lib/swap-failure').SwapFailureReceipt;
  };
  expect(result.failureReceipt).toMatchObject({
    networkFeeLamports: '5000',
    walletChangeRaw: '-5000',
    error: { customCode: 42 },
  });
  const after = (await (await activityRequest()).json()) as {
    events: import('@/lib/imported-signing-events').ImportedSigningEvent[];
  };
  expect(after.events[0].failureReceipt).toEqual(result.failureReceipt);
  expect(after.events.slice(1)).toEqual(before.events);
  expect(before.events[0].failureReceipt).toBeNull();
  expect(await reserved()).toBeNull();
  const calls = mocks.rpc.mock.calls.length;
  expect((await post({ action: 'recover', id })).status).toBe(200);
  expect(mocks.rpc.mock.calls.length).toBe(calls);
  expect(
    mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
  ).toHaveLength(0);
  await expect(
    mocks.db
      .prepare(
        'UPDATE imported_swap_signing_intents SET failure_receipt=NULL WHERE id=?',
      )
      .bind(id)
      .run(),
  ).rejects.toThrow();
  const history = await GET(
    new Request(
      'http://local/api/imported-projects/signing?projectId=' + projectId,
    ),
  );
  expect(history.status).toBe(200);
  const page = (await history.json()) as { intents: unknown[] };
  if (process.env.IMPORTED_FAILURE_QA_EXPORT === '1') {
    const fs = await import('node:fs/promises');
    const dir = new URL(
      '../../../../work/imported-failure-qa/',
      import.meta.url,
    );
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      new URL('fixture.json', dir),
      JSON.stringify({
        projectId,
        intents: page.intents,
        events: after.events,
      }),
      'utf8',
    );
  }
});
it('retains registered reservation if failed cost event cannot be stored atomically', async () => {
  const id = await reviewed();
  await post({ action: 'register', id, transaction: f.signed.transaction });
  const raw = {
    ...f.receipt,
    meta: {
      ...f.receipt.meta,
      postBalances: f.receipt.meta.preBalances.map((v, i) =>
        i === 0 ? (BigInt(v) - 5000n).toString() : v,
      ),
      err: 'InsufficientFundsForFee',
    },
  };
  mocks.rpc.mockImplementation(async (_endpoint, method) =>
    method === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : raw,
  );
  await mocks.db
    .prepare(
      "CREATE TRIGGER reject_failure BEFORE INSERT ON imported_swap_signing_events WHEN NEW.state='failed' BEGIN SELECT RAISE(ABORT,'test failure event'); END",
    )
    .run();
  try {
    expect((await post({ action: 'recover', id })).status).not.toBe(200);
    expect(
      await mocks.db
        .prepare(
          'SELECT state,failure_receipt FROM imported_swap_signing_intents WHERE id=?',
        )
        .bind(id)
        .first(),
    ).toEqual({ state: 'signed', failure_receipt: null });
    expect(await reserved()).toEqual({ scope: 'imported', state: 'signed' });
  } finally {
    await mocks.db.prepare('DROP TRIGGER reject_failure').run();
  }
  expect((await post({ action: 'recover', id })).status).toBe(200);
  expect(await reserved()).toBeNull();
});

// Synthetic packets and receipts in isolated D1 only. Never reaches a live provider.
const buyReceiptId = '33333333-3333-4333-8333-333333333333';
async function linkedSell() {
  for (const table of [
    'imported_token_projects',
    'imported_swap_preparations',
    'workspace_wallets',
  ])
    await mocks.db.prepare(`DELETE FROM ${table}`).run();
  f = await nativeWarmupFixture({ side: 'Sell', lookup: true, v2: true });
  await store(f);
  mocks.simulate.mockResolvedValue(f.simulation);
  const { default: bs58 } = await import('bs58');
  const doc = {
    network: 'mainnet',
    commitment: 'finalized',
    signatureVerified: true,
    signature: bs58.encode(new Uint8Array(64).fill(8)),
    wallet: f.wallet,
    mint: f.mint,
    decimals: 6,
    preparationSha256: 'a'.repeat(64),
    side: 'Buy',
    tokenUnitsRaw: '3000',
    source: 'fixture.test',
    observedAt: new Date().toISOString(),
    slot: 1,
    blockTime: null,
    networkFeeLamports: '1',
    nativeChangeRaw: '-101',
    rentChangeRaw: '0',
    nativeSettlementRaw: '-100',
  };
  await mocks.db
    .prepare('INSERT INTO imported_swap_receipts VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind(
      buyReceiptId,
      'alice',
      crypto.randomUUID(),
      crypto.randomUUID(),
      projectId,
      1,
      1,
      doc.signature,
      JSON.stringify(doc),
      doc.observedAt,
    )
    .run();
  const { captureImportedAcquisition } =
    await import('@/lib/imported-acquisition-server');
  const guard = await captureImportedAcquisition(
    mocks.db,
    'alice',
    projectId,
    f.wallet,
    f.mint,
    6,
    buyReceiptId,
    '1000',
  );
  await mocks.db
    .prepare(
      "UPDATE imported_swap_preparations SET document=json_set(document,'$.acquisition',json(?)) WHERE id=?",
    )
    .bind(JSON.stringify(guard.selection), preparationId)
    .run();
  return guard;
}
const lotState = () =>
  mocks.db
    .prepare(
      'SELECT buy_receipt_id AS buyReceiptId,sell_receipt_id AS sellReceiptId,units_raw AS unitsRaw FROM imported_trade_lot_links',
    )
    .all();
it('captures source and incremental basis in approval and events, commits exact sale and link across archives, then recovers idempotently', async () => {
  const guard = await linkedSell();
  const id = await reviewed();
  const approval = await mocks.db
    .prepare('SELECT document FROM imported_swap_signing_intents WHERE id=?')
    .bind(id)
    .first<{ document: string }>();
  expect(JSON.parse(approval!.document).acquisition).toEqual(guard.selection);
  expect(guard.selection.allocatedCostLamports).toBe('33');
  await expect(
    mocks.db
      .prepare(
        "UPDATE imported_swap_receipts SET document=json_set(document,'$.networkFeeLamports','2') WHERE id=?",
      )
      .bind(buyReceiptId)
      .run(),
  ).rejects.toThrow('immutable');
  await expect(
    mocks.db
      .prepare('DELETE FROM imported_swap_receipts WHERE id=?')
      .bind(buyReceiptId)
      .run(),
  ).rejects.toThrow('immutable');
  await expect(
    mocks.db
      .prepare("UPDATE imported_swap_preparations SET document='{}' WHERE id=?")
      .bind(preparationId)
      .run(),
  ).rejects.toThrow('immutable');
  await expect(
    mocks.db
      .prepare(
        "UPDATE imported_swap_signing_intents SET document='{}' WHERE id=?",
      )
      .bind(id)
      .run(),
  ).rejects.toThrow('immutable');
  expect(
    (await post({ action: 'register', id, transaction: f.signed.transaction }))
      .status,
  ).toBe(200);
  expect(
    (await post({ action: 'submit', id, transaction: f.signed.transaction }))
      .status,
  ).toBe(200);
  await mocks.db
    .prepare('UPDATE imported_token_projects SET archived=1,revision=2')
    .run();
  const response = await post({ action: 'recover', id });
  expect(response.status).toBe(200);
  const result = (await response.json()) as { receipt: { id: string } };
  expect((await lotState()).results).toEqual([
    { buyReceiptId, sellReceiptId: result.receipt.id, unitsRaw: '1000' },
  ]);
  expect(await reserved()).toBeNull();
  const { importedAcquisitionSnapshot } =
    await import('@/lib/imported-lot-links-server');
  const snapshot = await importedAcquisitionSnapshot(
    mocks.db,
    'alice',
    projectId,
  );
  expect(snapshot!.page.performance.lots[0]).toMatchObject({
    assignedSoldRaw: '1000',
    assignedCostLamports: '33',
  });
  const events = (await (await activityRequest()).json()) as {
    events: import('@/lib/imported-signing-events').ImportedSigningEvent[];
  };
  expect(events.events).toHaveLength(4);
  expect(
    events.events.every(
      (e) =>
        JSON.stringify(e.document.acquisition) ===
        JSON.stringify(guard.selection),
    ),
  ).toBe(true);
  const calls = mocks.rpc.mock.calls.length;
  expect((await post({ action: 'recover', id })).status).toBe(200);
  expect(mocks.rpc.mock.calls.length).toBe(calls);
  expect((await lotState()).results).toHaveLength(1);
  expect(
    mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
  ).toHaveLength(1);
  if (process.env.IMPORTED_ACQUISITION_QA_EXPORT === '1') {
    const fs = await import('node:fs/promises');
    const dir = new URL(
      '../../../../work/imported-acquisition-qa/',
      import.meta.url,
    );
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      new URL('fixture.json', dir),
      JSON.stringify({
        approvals: await (
          await GET(
            new Request(
              'http://localhost/api/imported-projects/signing?projectId=' +
                projectId,
            ),
          )
        ).json(),
        preparation: {
          ...(await mocks.db
            .prepare(
              'SELECT id,project_id AS projectId,project_revision AS projectRevision,wallet_revision AS walletRevision,created_at AS createdAt,document FROM imported_swap_preparations WHERE id=?',
            )
            .bind(preparationId)
            .first<{ document: string }>()),
          document: JSON.parse(
            (await mocks.db
              .prepare(
                'SELECT document FROM imported_swap_preparations WHERE id=?',
              )
              .bind(preparationId)
              .first<{ document: string }>())!.document,
          ),
        },
        review: JSON.parse(approval!.document),
        page: snapshot!.page,
        events: events.events,
      }),
      'utf8',
    );
  }
});
it.each(['cancel', 'failed'] as const)(
  'releases %s without consuming selected units or recording a sale link',
  async (outcome) => {
    await linkedSell();
    const id = await reviewed();
    if (outcome === 'cancel')
      expect((await post({ action: 'cancel', id })).status).toBe(200);
    else {
      await post({ action: 'register', id, transaction: f.signed.transaction });
      const failed = {
        ...f.receipt,
        meta: {
          ...f.receipt.meta,
          postBalances: f.receipt.meta.preBalances.map((v, i) =>
            i === 0 ? (BigInt(v) - 5000n).toString() : v,
          ),
          err: 'InsufficientFundsForFee',
        },
      };
      mocks.rpc.mockImplementation(async (_endpoint, method) =>
        method === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : failed,
      );
      const response = await post({ action: 'recover', id });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        state: 'failed',
        failureReceipt: { networkFeeLamports: '5000' },
      });
    }
    expect(await reserved()).toBeNull();
    expect((await lotState()).results).toHaveLength(0);
    expect(
      await mocks.db
        .prepare('SELECT COUNT(*) AS n FROM imported_swap_receipts')
        .first(),
    ).toEqual({ n: 1 });
  },
);
it.each(['document', 'revision'] as const)(
  'withholds approval when selected acquisition %s changes',
  async (kind) => {
    await linkedSell();
    if (kind === 'document')
      await mocks.db
        .prepare(
          "UPDATE imported_swap_receipts SET document=json_set(document,'$.source','changed.test')",
        )
        .run();
    else
      await mocks.db
        .prepare('INSERT INTO imported_trade_lot_gates VALUES(?,?,1,NULL)')
        .bind('alice', projectId)
        .run();
    expect(
      (
        await post({
          action: 'review',
          preparationId,
          transaction: f.order.preparation.transaction,
        })
      ).status,
    ).not.toBe(200);
    expect(await reserved()).toBeNull();
    expect(mocks.simulate).not.toHaveBeenCalled();
    expect(
      await mocks.db
        .prepare('SELECT COUNT(*) AS n FROM imported_swap_signing_intents')
        .first(),
    ).toEqual({ n: 0 });
  },
);
it.each(['link', 'event', 'gate'] as const)(
  'rolls back receipt, link, gate and terminal state if atomic %s storage fails',
  async (kind) => {
    await linkedSell();
    const id = await reviewed();
    await post({ action: 'register', id, transaction: f.signed.transaction });
    const sql =
      kind === 'link'
        ? "CREATE TRIGGER reject_acquisition BEFORE INSERT ON imported_trade_lot_links BEGIN SELECT RAISE(ABORT,'test link failure'); END"
        : kind === 'event'
          ? "CREATE TRIGGER reject_acquisition BEFORE INSERT ON imported_swap_signing_events WHEN NEW.state='finalized' BEGIN SELECT RAISE(ABORT,'test event failure'); END"
          : "CREATE TRIGGER reject_acquisition AFTER UPDATE ON imported_trade_lot_gates BEGIN UPDATE imported_trade_lot_gates SET write_token='changed' WHERE owner_id=NEW.owner_id AND project_id=NEW.project_id; END";
    await mocks.db.prepare(sql).run();
    try {
      expect((await post({ action: 'recover', id })).status).not.toBe(200);
      expect((await lotState()).results).toHaveLength(0);
      expect(
        await mocks.db
          .prepare('SELECT COUNT(*) AS n FROM imported_swap_receipts')
          .first(),
      ).toEqual({ n: 1 });
      expect(
        await mocks.db
          .prepare('SELECT COUNT(*) AS n FROM imported_trade_lot_gates')
          .first(),
      ).toEqual({ n: 0 });
      expect(await reserved()).toEqual({ scope: 'imported', state: 'signed' });
      expect(
        await mocks.db
          .prepare('SELECT COUNT(*) AS n FROM imported_swap_signing_events')
          .first(),
      ).toEqual({ n: 2 });
    } finally {
      await mocks.db.prepare('DROP TRIGGER reject_acquisition').run();
    }
    expect((await post({ action: 'recover', id })).status).toBe(200);
    expect((await lotState()).results).toHaveLength(1);
    expect(await reserved()).toBeNull();
  },
);
it('rechecks original buy and revision atomically when saving and reserving source-selected preparation', async () => {
  const guard = await linkedSell();
  const { saveSwapPreparation } =
    await import('@/lib/imported-swap-preparation-history');
  const row = await mocks.db
    .prepare('SELECT document FROM imported_swap_preparations WHERE id=?')
    .bind(preparationId)
    .first<{ document: string }>();
  const doc = JSON.parse(row!.document);
  const ctx = {
    projectId,
    projectRevision: 1,
    wallet: f.wallet,
    walletRevision: 1,
  };
  expect(
    await saveSwapPreparation(mocks.db, 'alice', ctx, doc, guard),
  ).not.toBeNull();
  expect(
    await saveSwapPreparation(mocks.db, 'alice', ctx, doc, {
      ...guard,
      rawBuyDocument: '{}',
    }),
  ).toBeNull();
  mocks.simulate.mockImplementation(async () => {
    await mocks.db
      .prepare('INSERT INTO imported_trade_lot_gates VALUES(?,?,1,NULL)')
      .bind('alice', projectId)
      .run();
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
  ).not.toBe(200);
  expect(await reserved()).toBeNull();
  expect(
    await saveSwapPreparation(mocks.db, 'alice', ctx, doc, guard),
  ).toBeNull();
});
it('allows unrelated project accounting to advance while preventing manual assignments on the reserved wallet', async () => {
  const guard = await linkedSell();
  const { default: bs58 } = await import('bs58');
  async function extra(n: number, side: 'Buy' | 'Sell', wallet: string) {
    const row = await mocks.db
      .prepare('SELECT document FROM imported_swap_receipts WHERE id=?')
      .bind(buyReceiptId)
      .first<{ document: string }>();
    const doc = {
      ...JSON.parse(row!.document),
      wallet,
      signature: bs58.encode(new Uint8Array(64).fill(n)),
      side,
      slot: n,
      tokenUnitsRaw: '1000',
      nativeChangeRaw: side === 'Buy' ? '-101' : '49',
      nativeSettlementRaw: side === 'Buy' ? '-100' : '50',
    };
    const rid = crypto.randomUUID();
    await mocks.db
      .prepare('INSERT INTO imported_swap_receipts VALUES(?,?,?,?,?,?,?,?,?,?)')
      .bind(
        rid,
        'alice',
        crypto.randomUUID(),
        crypto.randomUUID(),
        projectId,
        1,
        1,
        doc.signature,
        JSON.stringify(doc),
        doc.observedAt,
      )
      .run();
    return rid;
  }
  const sameSale = await extra(12, 'Sell', f.wallet),
    otherWallet = bs58.encode(new Uint8Array(32).fill(13)),
    otherBuy = await extra(14, 'Buy', otherWallet),
    otherSale = await extra(15, 'Sell', otherWallet);
  const id = await reviewed();
  const { POST: assign } = await import('../lot-links/route');
  const { importedAcquisitionSnapshot } =
    await import('@/lib/imported-lot-links-server');
  async function assignPair(buy: string, sell: string) {
    const page = (await importedAcquisitionSnapshot(
      mocks.db,
      'alice',
      projectId,
    ))!.page;
    return assign(
      new Request('http://localhost/api/imported-projects/lot-links', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost',
        },
        body: JSON.stringify({
          projectId,
          buyReceiptId: buy,
          sellReceiptId: sell,
          revision: page.revision,
          buyDocumentSha256: page.receiptDocumentHashes[buy],
          sellDocumentSha256: page.receiptDocumentHashes[sell],
        }),
      }),
    );
  }
  expect((await assignPair(buyReceiptId, sameSale)).status).toBe(409);
  expect((await assignPair(otherBuy, otherSale)).status).toBe(200);
  await post({ action: 'register', id, transaction: f.signed.transaction });
  expect(
    (await post({ action: 'submit', id, transaction: f.signed.transaction }))
      .status,
  ).toBe(200);
  expect((await post({ action: 'recover', id })).status).toBe(200);
  expect((await lotState()).results).toHaveLength(2);
  expect(guard.selection.linkRevision).toBe(0);
  expect(
    await mocks.db
      .prepare('SELECT revision FROM imported_trade_lot_gates')
      .first(),
  ).toEqual({ revision: 2 });
});

it.each(['success', 'overallocated', 'changed'] as const)(
  'prepares a captured selected source through the owned API with %s evidence',
  async (mode) => {
    const guard = await linkedSell();
    const now = new Date().toISOString();
    mocks.balance.mockResolvedValue({
      executionAllowed: false,
      wallet: f.wallet,
      mint: f.mint,
      side: 'Sell',
      source: 'fixture.test',
      observedAt: now,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      requestedRaw: '1000',
      amountCovered: true,
      preparationSupported: true,
      nativeSlot: 100,
    });
    mocks.prepare.mockImplementation(async () => {
      if (mode === 'changed')
        await mocks.db
          .prepare(
            "UPDATE imported_swap_receipts SET document=json_set(document,'$.source','changed.test') WHERE id=?",
          )
          .bind(buyReceiptId)
          .run();
      return f.order;
    });
    const request = new Request(
      'http://localhost/api/imported-projects/prepare',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost',
        },
        body: JSON.stringify({
          id: projectId,
          revision: 1,
          wallet: f.wallet,
          walletRevision: 1,
          side: 'Sell',
          amount: mode === 'overallocated' ? '0.003001' : '0.001',
          buyReceiptId,
        }),
      },
    );
    const response = await prepareImported(request);
    if (mode === 'success') {
      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        history: { document: { acquisition: unknown } };
      };
      expect(data.history.document.acquisition).toEqual(guard.selection);
      expect(mocks.prepare).toHaveBeenCalledTimes(1);
      expect(mocks.balance).toHaveBeenCalledTimes(1);
    } else {
      expect(response.status).not.toBe(200);
      expect(
        await mocks.db
          .prepare('SELECT COUNT(*) AS n FROM imported_swap_preparations')
          .first(),
      ).toEqual({ n: 1 });
      if (mode === 'overallocated') {
        expect(mocks.prepare).not.toHaveBeenCalled();
        expect(mocks.balance).not.toHaveBeenCalled();
      }
    }
    expect(
      mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
    ).toHaveLength(0);
  },
);

async function linkedBasket(count = 2) {
  await linkedSell();
  const raw = (await mocks.db
    .prepare('SELECT document FROM imported_swap_receipts WHERE id=?')
    .bind(buyReceiptId)
    .first<{ document: string }>())!.document;
  const ids = [buyReceiptId],
    { default: bs58 } = await import('bs58');
  for (let index = 1; index < count; index++) {
    const rid = `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`;
    const doc = {
      ...JSON.parse(raw),
      signature: bs58.encode(new Uint8Array(64).fill(8 + index)),
      slot: index + 1,
    };
    await mocks.db
      .prepare('INSERT INTO imported_swap_receipts VALUES(?,?,?,?,?,?,?,?,?,?)')
      .bind(
        rid,
        'alice',
        crypto.randomUUID(),
        crypto.randomUUID(),
        projectId,
        1,
        1,
        doc.signature,
        JSON.stringify(doc),
        doc.observedAt,
      )
      .run();
    ids.push(rid);
  }
  const { captureImportedAcquisitionBasket } =
    await import('@/lib/imported-acquisition-server');
  const allocations = ids.map((id, index) => ({
    buyReceiptId: id,
    unitsRaw: count === 2 ? (index === 0 ? '400' : '600') : '125',
  }));
  const guard = await captureImportedAcquisitionBasket(
    mocks.db,
    'alice',
    projectId,
    f.wallet,
    f.mint,
    6,
    allocations,
    '1000',
  );
  await mocks.db
    .prepare(
      "UPDATE imported_swap_preparations SET document=json_set(document,'$.acquisition',json(?)) WHERE id=?",
    )
    .bind(JSON.stringify(guard.selection), preparationId)
    .run();
  return guard;
}
it.each([2, 8])(
  'captures %i acquisitions through approval, signature, finalized receipt and every immutable event',
  async (count) => {
    const guard = await linkedBasket(count),
      id = await reviewed();
    const intent = (await mocks.db
      .prepare('SELECT document FROM imported_swap_signing_intents WHERE id=?')
      .bind(id)
      .first<{ document: string }>())!;
    expect(intent.document.length).toBeLessThanOrEqual(8192);
    expect(JSON.parse(intent.document).acquisition).toEqual(guard.selection);
    for (const source of guard.sources) {
      await expect(
        mocks.db
          .prepare(
            "UPDATE imported_swap_receipts SET document=json_set(document,'$.source','changed.test') WHERE id=?",
          )
          .bind(source.selection.buyReceiptId)
          .run(),
      ).rejects.toThrow('immutable');
      await expect(
        mocks.db
          .prepare('DELETE FROM imported_swap_receipts WHERE id=?')
          .bind(source.selection.buyReceiptId)
          .run(),
      ).rejects.toThrow('immutable');
    }
    expect(
      (
        await post({
          action: 'register',
          id,
          transaction: f.signed.transaction,
        })
      ).status,
    ).toBe(200);
    await expect(
      mocks.db
        .prepare(
          "UPDATE imported_swap_signing_intents SET state='finalized' WHERE id=?",
        )
        .bind(id)
        .run(),
    ).rejects.toThrow('incomplete');
    expect(
      (await post({ action: 'submit', id, transaction: f.signed.transaction }))
        .status,
    ).toBe(200);
    await mocks.db
      .prepare('UPDATE imported_token_projects SET archived=1,revision=2')
      .run();
    const result = await post({ action: 'recover', id });
    expect(result.status).toBe(200);
    const { receipt } = (await result.json()) as { receipt: { id: string } };
    expect((await lotState()).results).toEqual(
      guard.selection.allocations.map((a) => ({
        buyReceiptId: a.buyReceiptId,
        sellReceiptId: receipt.id,
        unitsRaw: a.unitsRaw,
      })),
    );
    expect(await reserved()).toBeNull();
    const { importedAcquisitionSnapshot } =
      await import('@/lib/imported-lot-links-server');
    const page = (await importedAcquisitionSnapshot(
      mocks.db,
      'alice',
      projectId,
    ))!.page;
    if (count === 2) {
      const { POST: assign } = await import('../lot-links/route');
      const first = guard.selection.allocations[0];
      const attempted = await assign(
        new Request('http://localhost/api/imported-projects/lot-links', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'http://localhost',
          },
          body: JSON.stringify({
            projectId,
            buyReceiptId: first.buyReceiptId,
            sellReceiptId: receipt.id,
            revision: page.revision,
            buyDocumentSha256: page.receiptDocumentHashes[first.buyReceiptId],
            sellDocumentSha256: page.receiptDocumentHashes[receipt.id],
          }),
        }),
      );
      expect(attempted.status).toBe(409);
      expect((await lotState()).results).toHaveLength(2);
    }
    expect(page.performance.linkedSaleCount).toBe(1);
    expect(page.performance.assignedCostLamports).toBe(
      count === 2 ? '33' : '32',
    );
    const events = (await (await activityRequest()).json()) as {
      events: import('@/lib/imported-signing-events').ImportedSigningEvent[];
    };
    expect(events.events).toHaveLength(4);
    for (const event of events.events)
      expect(event.document.acquisition).toEqual(guard.selection);
    const calls = mocks.rpc.mock.calls.length;
    expect((await post({ action: 'recover', id })).status).toBe(200);
    expect(mocks.rpc.mock.calls.length).toBe(calls);
    expect(
      mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
    ).toHaveLength(1);
    if (count === 2 && process.env.IMPORTED_BASKET_QA_EXPORT === '1') {
      const fs = await import('node:fs/promises');
      const dir = new URL(
        '../../../../work/imported-basket-flow-qa/',
        import.meta.url,
      );
      await fs.mkdir(dir, { recursive: true });
      const preparations = await mocks.db
        .prepare(
          'SELECT id,project_id AS projectId,project_revision AS projectRevision,wallet_revision AS walletRevision,created_at AS createdAt,document FROM imported_swap_preparations WHERE id=?',
        )
        .bind(preparationId)
        .first<{ document: string }>();
      await fs.writeFile(
        new URL('fixture.json', dir),
        JSON.stringify({
          review: JSON.parse(intent.document),
          preparation: {
            ...preparations,
            document: JSON.parse(preparations!.document),
          },
          page,
          events,
          approvals: await (
            await GET(
              new Request(
                'http://localhost/api/imported-projects/signing?projectId=' +
                  projectId,
              ),
            )
          ).json(),
        }),
      );
    }
  },
);
it.each(['second-link', 'event', 'gate'] as const)(
  'rolls back every basket source and receipt when %s storage fails',
  async (failure) => {
    const guard = await linkedBasket(),
      id = await reviewed();
    await post({ action: 'register', id, transaction: f.signed.transaction });
    const sql =
      failure === 'second-link'
        ? `CREATE TRIGGER reject_basket BEFORE INSERT ON imported_trade_lot_links WHEN NEW.buy_receipt_id='${guard.selection.allocations[1].buyReceiptId}' BEGIN SELECT RAISE(ABORT,'test second source failure'); END`
        : failure === 'event'
          ? "CREATE TRIGGER reject_basket BEFORE INSERT ON imported_swap_signing_events WHEN NEW.state='finalized' BEGIN SELECT RAISE(ABORT,'test event failure'); END"
          : "CREATE TRIGGER reject_basket AFTER UPDATE ON imported_trade_lot_gates BEGIN UPDATE imported_trade_lot_gates SET write_token='changed' WHERE owner_id=NEW.owner_id AND project_id=NEW.project_id; END";
    await mocks.db.prepare(sql).run();
    try {
      expect((await post({ action: 'recover', id })).status).not.toBe(200);
      expect((await lotState()).results).toHaveLength(0);
      expect(
        await mocks.db
          .prepare('SELECT COUNT(*) AS n FROM imported_swap_receipts')
          .first(),
      ).toEqual({ n: 2 });
      expect(
        await mocks.db
          .prepare('SELECT COUNT(*) AS n FROM imported_trade_lot_gates')
          .first(),
      ).toEqual({ n: 0 });
      expect(await reserved()).toEqual({ scope: 'imported', state: 'signed' });
    } finally {
      await mocks.db.prepare('DROP TRIGGER reject_basket').run();
    }
    expect((await post({ action: 'recover', id })).status).toBe(200);
    expect((await lotState()).results).toHaveLength(2);
    expect(await reserved()).toBeNull();
  },
);
it.each(['cancel', 'failed'] as const)(
  'keeps every basket source unconsumed on %s and retains captured failure evidence',
  async (state) => {
    const guard = await linkedBasket(),
      id = await reviewed();
    if (state === 'cancel')
      expect((await post({ action: 'cancel', id })).status).toBe(200);
    else {
      await post({ action: 'register', id, transaction: f.signed.transaction });
      const raw = {
        ...f.receipt,
        meta: {
          ...f.receipt.meta,
          postBalances: f.receipt.meta.preBalances.map((v, i) =>
            i === 0 ? (BigInt(v) - 5000n).toString() : v,
          ),
          err: { InstructionError: ['0', { Custom: '42' }] },
        },
      };
      mocks.rpc.mockImplementation(async (_endpoint, method) =>
        method === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : raw,
      );
      expect((await post({ action: 'recover', id })).status).toBe(200);
      const events = (await (await activityRequest()).json()) as {
        events: import('@/lib/imported-signing-events').ImportedSigningEvent[];
      };
      expect(events.events[0].failureReceipt?.networkFeeLamports).toBe('5000');
      expect(events.events[0].document.acquisition).toEqual(guard.selection);
    }
    expect((await lotState()).results).toHaveLength(0);
    expect(
      await mocks.db
        .prepare('SELECT COUNT(*) AS n FROM imported_swap_receipts')
        .first(),
    ).toEqual({ n: 2 });
    expect(await reserved()).toBeNull();
  },
);
it.each([0, 1])(
  'guards basket source %i against a save or reservation race',
  async (index) => {
    const guard = await linkedBasket();
    const { saveSwapPreparation } =
      await import('@/lib/imported-swap-preparation-history');
    const raw = (await mocks.db
      .prepare('SELECT document FROM imported_swap_preparations WHERE id=?')
      .bind(preparationId)
      .first<{ document: string }>())!.document;
    const context = {
      projectId,
      projectRevision: 1,
      wallet: f.wallet,
      walletRevision: 1,
    };
    expect(
      await saveSwapPreparation(mocks.db, 'alice', context, JSON.parse(raw), {
        ...guard,
        sources: guard.sources.map((s, i) =>
          i === index ? { ...s, rawBuyDocument: '{}' } : s,
        ),
      }),
    ).toBeNull();
    mocks.simulate.mockImplementation(async () => {
      await mocks.db
        .prepare(
          "UPDATE imported_swap_receipts SET document=json_set(document,'$.source','changed.test') WHERE id=?",
        )
        .bind(guard.selection.allocations[index].buyReceiptId)
        .run();
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
    ).not.toBe(200);
    expect(await reserved()).toBeNull();
    expect(
      await mocks.db
        .prepare('SELECT COUNT(*) AS n FROM imported_swap_signing_intents')
        .first(),
    ).toEqual({ n: 0 });
  },
);
it('prepares exact multiple source allocations through the owned API and rejects duplicate or mismatched inputs before providers', async () => {
  const guard = await linkedBasket(),
    allocations = guard.selection.allocations.map(
      ({ buyReceiptId, unitsRaw }) => ({ buyReceiptId, unitsRaw }),
    );
  const request = (buyAllocations: unknown) =>
    new Request('http://localhost/api/imported-projects/prepare', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify({
        id: projectId,
        revision: 1,
        wallet: f.wallet,
        walletRevision: 1,
        side: 'Sell',
        amount: '0.001',
        buyAllocations,
      }),
    });
  for (const invalid of [
    [allocations[0], allocations[0]],
    [{ ...allocations[0], unitsRaw: '401' }, allocations[1]],
  ]) {
    expect((await prepareImported(request(invalid))).status).toBe(400);
    expect(mocks.balance).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  }
  const now = new Date().toISOString();
  mocks.balance.mockResolvedValue({
    executionAllowed: false,
    wallet: f.wallet,
    mint: f.mint,
    side: 'Sell',
    source: 'fixture.test',
    observedAt: now,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    requestedRaw: '1000',
    amountCovered: true,
    preparationSupported: true,
    nativeSlot: 100,
  });
  mocks.prepare.mockResolvedValue(f.order);
  const response = await prepareImported(request([...allocations].reverse()));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    history: { document: { acquisition: guard.selection } },
  });
  expect(mocks.balance).toHaveBeenCalledTimes(1);
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
});
