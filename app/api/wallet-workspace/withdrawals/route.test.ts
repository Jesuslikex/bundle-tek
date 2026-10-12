import { afterAll, beforeAll, beforeEach, it, expect, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { nativeWithdrawalFixture } from '../../../../test/native-withdrawal-fixture';
import { tokenWithdrawalFixture } from '../../../../test/token-withdrawal-fixture';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  fetcher: null as unknown as typeof fetch,
  rpc: vi.fn(),
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/native-withdrawal-server', async (original) => {
  const actual =
    await original<typeof import('@/lib/native-withdrawal-server')>();
  return {
    ...actual,
    prepareNativeWithdrawal: (
      input: Parameters<typeof actual.prepareNativeWithdrawal>[0],
      signal: AbortSignal,
      fetcher?: typeof fetch,
    ) =>
      actual.prepareNativeWithdrawal(input, signal, fetcher ?? mocks.fetcher),
    recheckNativeWithdrawal: (
      review: Parameters<typeof actual.recheckNativeWithdrawal>[0],
      signal: AbortSignal,
      fetcher?: typeof fetch,
    ) =>
      actual.recheckNativeWithdrawal(review, signal, fetcher ?? mocks.fetcher),
  };
});
vi.mock('@/lib/token-withdrawal-server', async (original) => {
  const actual =
    await original<typeof import('@/lib/token-withdrawal-server')>();
  return {
    ...actual,
    prepareTokenWithdrawal: (
      input: Parameters<typeof actual.prepareTokenWithdrawal>[0],
      signal: AbortSignal,
      fetcher?: typeof fetch,
    ) => actual.prepareTokenWithdrawal(input, signal, fetcher ?? mocks.fetcher),
    recheckTokenWithdrawal: (
      review: Parameters<typeof actual.recheckTokenWithdrawal>[0],
      signal: AbortSignal,
      fetcher?: typeof fetch,
    ) =>
      actual.recheckTokenWithdrawal(review, signal, fetcher ?? mocks.fetcher),
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
import { GET, POST } from './route';
import { GET as withdrawalActivity } from './activity/route';
import {
  SOLANA_MAINNET_GENESIS,
  parseBalanceJson,
} from '@/lib/wallet-balances';
import type { NativeWithdrawal } from '@/lib/native-withdrawal';
import { validateFunding } from '@/lib/funding-plan';
import { requireSelectedFundingReview } from '@/lib/mainnet-funding';
let mf: Miniflare, f: Awaited<ReturnType<typeof nativeWithdrawalFixture>>;
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'withdrawal-test',
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
          env: { DB: { type: 'd1', id: 'withdrawal-test-only' } },
        },
      },
    ],
  });
  mocks.db = await mf.getD1Database('DB', 'withdrawal-test');
  await mocks.db
    .prepare(
      'CREATE TABLE funding_plans(owner_id TEXT,id TEXT,document TEXT,revision INTEGER,archived INTEGER,updated_at TEXT,PRIMARY KEY(owner_id,id))',
    )
    .run();
  for (const name of [
    '0024_imported_token_projects',
    '0041_imported_swap_preparations',
    '0045_warmup_signing_intents',
    '0047_shared_swap_reservations',
    '0049_native_withdrawals',
    '0050_withdrawal_failure_evidence',
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
  await mocks.db
    .prepare(
      'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
    )
    .run();
});
afterAll(async () => mf?.dispose());
beforeEach(async () => {
  mocks.user = { userId: 'alice' };
  for (const trigger of [
    'native_withdrawal_delete',
    'native_withdrawal_event_delete',
    'event_reject',
  ])
    await mocks.db.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
  for (const table of [
    'native_withdrawals',
    'native_withdrawal_events',
    'warmup_signing_intents',
    'imported_swap_signing_intents',
    'solana_swap_reservations',
    'solana_swap_signatures',
    'solana_execution_reservations',
    'solana_execution_signatures',
    'workspace_wallets',
    'funding_plans',
  ])
    await mocks.db.prepare(`DELETE FROM ${table}`).run();
  await mocks.db
    .prepare(
      "CREATE TRIGGER native_withdrawal_delete BEFORE DELETE ON native_withdrawals BEGIN SELECT RAISE(ABORT,'Withdrawal history is retained'); END",
    )
    .run();
  await mocks.db
    .prepare(
      "CREATE TRIGGER native_withdrawal_event_delete BEFORE DELETE ON native_withdrawal_events BEGIN SELECT RAISE(ABORT,'Withdrawal event is immutable'); END",
    )
    .run();
  f = await nativeWithdrawalFixture();
  mocks.fetcher = f.fetcher;
  await mocks.db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,0)')
    .bind('alice', 'Solana', f.wallet, 1)
    .run();
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
const post = (body: object) =>
  POST(
    new Request('http://localhost/api/wallet-workspace/withdrawals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const get = (extra = '') =>
  GET(
    new Request(
      `http://localhost/api/wallet-workspace/withdrawals?wallet=${f.wallet}${extra}`,
    ),
  );
const activity = (query = '') =>
  withdrawalActivity(
    new Request(
      'http://localhost/api/wallet-workspace/withdrawals/activity' + query,
    ),
  );
async function prepared() {
  const result = await post({
    action: 'prepare',
    wallet: f.wallet,
    walletRevision: 1,
    recipient: f.recipient,
    amount: '0.01',
  });
  expect(result.status).toBe(200);
  return ((await result.json()) as { withdrawal: NativeWithdrawal }).withdrawal;
}
async function registered() {
  const row = await prepared();
  expect((await post({ action: 'begin_signing', id: row.id })).status).toBe(
    200,
  );
  expect(
    (
      await post({
        action: 'register',
        id: row.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(200);
  return row;
}
const lock = () =>
  mocks.db
    .prepare(
      'SELECT scope,state FROM solana_execution_reservations WHERE owner_id=? AND wallet_address=?',
    )
    .bind('alice', f.wallet)
    .first();
async function fundingPlan() {
  const plan = {
    id: 'funding-native-qa',
    revision: 1,
    archived: false,
    updatedAt: new Date().toISOString(),
    document: validateFunding({
      name: 'Native funding QA',
      chain: 'Solana',
      currency: 'SOL',
      source: 'Wallet',
      sourceLabel: '',
      funderAddress: f.wallet,
      startAt: new Date(Date.now() - 1000).toISOString(),
      delaySeconds: 0,
      recipients: [{ address: f.recipient, amount: '0.01' }],
    }),
  };
  await mocks.db
    .prepare('INSERT INTO funding_plans VALUES(?,?,?,?,?,?)')
    .bind('alice', plan.id, JSON.stringify(plan.document), 1, 0, plan.updatedAt)
    .run();
  return plan;
}
async function prepareFunding(planId = 'funding-native-qa') {
  return post({
    action: 'prepare',
    wallet: f.wallet,
    walletRevision: 1,
    recipient: f.recipient,
    amount: '0.01',
    funding: { planId, revision: 1, item: 1 },
  });
}
it.each([
  [false, false],
  [true, false],
  [true, true],
])(
  'binds token funding to catalog mint and precision with Token-2022=%s fee=%s, retaining exact recipient credit',
  async (token2022, fee) => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const tokenFixture = await tokenWithdrawalFixture(false, token2022, fee, {
      mint,
      amountRaw: 1000000n,
    });
    f = { ...f, ...tokenFixture };
    mocks.fetcher = vi.fn(f.fetcher);
    const plan = {
      id: 'token-funding-qa',
      revision: 1,
      archived: false,
      updatedAt: new Date().toISOString(),
      document: validateFunding({
        name: 'Token funding QA',
        chain: 'Solana',
        currency: 'USDC',
        assetAddress: mint,
        source: 'Wallet',
        sourceLabel: '',
        funderAddress: f.wallet,
        startAt: new Date(Date.now() - 1000).toISOString(),
        delaySeconds: 0,
        recipients: [{ address: f.recipient, amount: '1' }],
      }),
    };
    await mocks.db
      .prepare('INSERT INTO funding_plans VALUES(?,?,?,?,?,?)')
      .bind(
        'alice',
        plan.id,
        JSON.stringify(plan.document),
        1,
        0,
        plan.updatedAt,
      )
      .run();
    const prepare = (extra: object = {}) =>
      post({
        action: 'prepare',
        wallet: f.wallet,
        walletRevision: 1,
        recipient: f.recipient,
        amount: '1',
        mint,
        decimals: 6,
        funding: { planId: plan.id, revision: 1, item: 1 },
        ...extra,
      });
    const before = (mocks.fetcher as unknown as ReturnType<typeof vi.fn>).mock
      .calls.length;
    expect((await prepare({ decimals: 7 })).status).toBe(409);
    expect(
      (await prepare({ mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' }))
        .status,
    ).toBe(409);
    expect((await prepare({ amount: '2' })).status).toBe(409);
    expect(
      (mocks.fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(before);
    const response = await prepare();
    expect(response.status).toBe(200);
    const row = ((await response.json()) as { withdrawal: NativeWithdrawal })
      .withdrawal;
    await expect(
      requireSelectedFundingReview(row.document, plan, 1),
    ).resolves.toBeUndefined();
    expect(row.document.token).toMatchObject({
      mint,
      decimals: 6,
      createAccount: true,
    });
    expect(row.document.amountRaw).toBe('1000000');
    if (fee)
      expect(row.document.token?.transferFee).toMatchObject({
        feeRaw: '100',
        netAmountRaw: '999900',
      });
    if (fee && process.env.FUNDING_TOKEN_QA_EXPORT === '1') {
      const directory = new URL(
        '../../../../work/mainnet-token-funding-qa/',
        import.meta.url,
      );
      await mkdir(directory, { recursive: true });
      await writeFile(
        new URL('fixture.json', directory),
        JSON.stringify({ plan, row }),
        'utf8',
      );
    }
    expect((await post({ action: 'begin_signing', id: row.id })).status).toBe(
      200,
    );
    expect(
      (
        await post({
          action: 'register',
          id: row.id,
          transaction: f.signed.transaction,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post({
          action: 'submit',
          id: row.id,
          transaction: f.signed.transaction,
        })
      ).status,
    ).toBe(200);
    const outcome = await post({ action: 'recover', id: row.id });
    expect(outcome.status).toBe(200);
    expect(
      ((await outcome.json()) as { withdrawal: NativeWithdrawal }).withdrawal
        .receipt?.token?.destinationChangeRaw,
    ).toBe(fee ? '999900' : '1000000');
    expect((await prepare()).status).toBe(409);
  },
);
it('binds mainnet funding to one exact saved recipient, submits once, recovers across archival and rejects repeat funding', async () => {
  const plan = await fundingPlan();
  const response = await prepareFunding();
  expect(response.status).toBe(200);
  const row = ((await response.json()) as { withdrawal: NativeWithdrawal })
    .withdrawal;
  await expect(
    requireSelectedFundingReview(row.document, plan, 1),
  ).resolves.toBeUndefined();
  if (process.env.FUNDING_MAINNET_QA_EXPORT === '1') {
    const directory = new URL(
      '../../../../work/mainnet-funding-qa/',
      import.meta.url,
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      new URL('fixture.json', directory),
      JSON.stringify({ plan, row }),
      'utf8',
    );
  }
  const scope = `&planId=${plan.id}&revision=1&item=1`;
  expect(await (await get(scope)).json()).toMatchObject({
    active: { id: row.id },
    withdrawals: [{ id: row.id }],
  });
  expect(
    await (await get(`&planId=other-plan&revision=1&item=1`)).json(),
  ).toMatchObject({ active: null, withdrawals: [] });
  expect(
    (await get(`&planId=other-plan&revision=1&item=1&cursor=${row.id}`)).status,
  ).toBe(400);
  expect((await post({ action: 'begin_signing', id: row.id })).status).toBe(
    200,
  );
  expect(
    (
      await post({
        action: 'register',
        id: row.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post({
        action: 'submit',
        id: row.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(200);
  expect((await post({ action: 'recover', id: row.id })).status).toBe(200);
  expect((await prepareFunding()).status).toBe(409);
  await mocks.db
    .prepare('UPDATE funding_plans SET archived=1,revision=2')
    .run();
  expect((await post({ action: 'recover', id: row.id })).status).toBe(200);
  expect(await (await get(scope)).json()).toMatchObject({
    withdrawals: [
      {
        id: row.id,
        state: 'finalized',
        document: { funding: { planId: plan.id, revision: 1, item: 1 } },
      },
    ],
  });
  expect(
    mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
  ).toHaveLength(1);
});
it('withholds signing and submission after funding edits, but retains signature registration and receipt recovery', async () => {
  await fundingPlan();
  const row = (
    (await (await prepareFunding()).json()) as { withdrawal: NativeWithdrawal }
  ).withdrawal;
  await mocks.db.prepare('UPDATE funding_plans SET revision=2').run();
  expect((await post({ action: 'begin_signing', id: row.id })).status).toBe(
    409,
  );
  expect(await lock()).toMatchObject({ state: 'awaiting_signature' });
  await mocks.db.prepare('UPDATE funding_plans SET revision=1').run();
  expect((await post({ action: 'begin_signing', id: row.id })).status).toBe(
    200,
  );
  await mocks.db
    .prepare('UPDATE funding_plans SET archived=1,revision=2')
    .run();
  expect(
    (
      await post({
        action: 'register',
        id: row.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post({
        action: 'submit',
        id: row.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(409);
  expect(await lock()).toMatchObject({ state: 'signed' });
  expect(
    mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
  ).toHaveLength(0);
  expect((await post({ action: 'recover', id: row.id })).status).toBe(200);
});
it('rejects unavailable, malformed, not due and substituted funding terms before provider reads', async () => {
  const plan = await fundingPlan();
  const callCount = (mocks.fetcher as unknown as ReturnType<typeof vi.fn>).mock
    .calls.length;
  for (const patch of [
    { funding: { planId: plan.id, revision: 2, item: 1 } },
    { funding: { planId: plan.id, revision: 1, item: 2 } },
    { amount: '0.02' },
  ])
    expect(
      (
        await post({
          action: 'prepare',
          wallet: f.wallet,
          walletRevision: 1,
          recipient: f.recipient,
          amount: '0.01',
          funding: { planId: plan.id, revision: 1, item: 1 },
          ...patch,
        })
      ).status,
    ).toBe(409);
  expect((await prepareFunding('missing-plan')).status).toBe(409);
  expect(
    (
      await post({
        action: 'prepare',
        funding: { planId: plan.id, revision: 1, item: 0 },
      })
    ).status,
  ).toBe(400);
  mocks.user = { userId: 'mallory' };
  await mocks.db
    .prepare("INSERT INTO workspace_wallets VALUES('mallory','Solana',?,1,0)")
    .bind(f.wallet)
    .run();
  expect((await prepareFunding()).status).toBe(409);
  mocks.user = { userId: 'alice' };
  plan.document = validateFunding({
    ...plan.document,
    startAt: new Date(Date.now() + 60000).toISOString(),
  });
  await mocks.db
    .prepare('UPDATE funding_plans SET document=?')
    .bind(JSON.stringify(plan.document))
    .run();
  expect((await prepareFunding()).status).toBe(409);
  expect(
    (mocks.fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls,
  ).toHaveLength(callCount);
});
it('atomically rejects a funding change immediately before preparation, signing claim and submission', async () => {
  await fundingPlan();
  const real = mocks.db;
  const race = (prefix: string) => {
    mocks.db = new Proxy(real, {
      get(target, key) {
        if (key !== 'prepare') return Reflect.get(target, key);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith(prefix)) return statement;
          return new Proxy(statement, {
            get(inner, property) {
              if (property !== 'bind') return Reflect.get(inner, property);
              return (...args: unknown[]) => {
                const bound = inner.bind(...args);
                return new Proxy(bound, {
                  get(query, operation) {
                    if (operation !== 'first')
                      return Reflect.get(query, operation);
                    return async () => {
                      await real
                        .prepare('UPDATE funding_plans SET revision=revision+1')
                        .run();
                      return query.first();
                    };
                  },
                });
              };
            },
          });
        };
      },
    });
  };
  try {
    race('INSERT INTO native_withdrawals (');
    expect((await prepareFunding()).status).toBe(409);
    expect(
      await real.prepare('SELECT id FROM native_withdrawals').first(),
    ).toBeNull();
    mocks.db = real;
    await real.prepare('UPDATE funding_plans SET revision=1').run();
    const row = (
      (await (await prepareFunding()).json()) as {
        withdrawal: NativeWithdrawal;
      }
    ).withdrawal;
    race("UPDATE native_withdrawals SET state='signing'");
    expect((await post({ action: 'begin_signing', id: row.id })).status).toBe(
      409,
    );
    mocks.db = real;
    await real.prepare('UPDATE funding_plans SET revision=1').run();
    expect((await post({ action: 'begin_signing', id: row.id })).status).toBe(
      200,
    );
    expect(
      (
        await post({
          action: 'register',
          id: row.id,
          transaction: f.signed.transaction,
        })
      ).status,
    ).toBe(200);
    race("UPDATE native_withdrawals SET state='submitted'");
    expect(
      (
        await post({
          action: 'submit',
          id: row.id,
          transaction: f.signed.transaction,
        })
      ).status,
    ).toBe(409);
    expect(
      await real
        .prepare('SELECT state FROM native_withdrawals WHERE id=?')
        .bind(row.id)
        .first(),
    ).toEqual({ state: 'signed' });
    expect(
      mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
    ).toHaveLength(0);
  } finally {
    mocks.db = real;
  }
});
it('retains exact approval, signing and single submission, then recovers a finalized receipt across wallet archive', async () => {
  const row = await registered();
  expect(await lock()).toEqual({ scope: 'withdrawal', state: 'signed' });
  expect(
    (
      await post({
        action: 'register',
        id: row.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(200);
  expect((await post({ action: 'cancel', id: row.id })).status).toBe(409);
  expect(
    (
      await post({
        action: 'submit',
        id: row.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post({
        action: 'submit',
        id: row.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(409);
  expect(
    mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
  ).toHaveLength(1);
  await mocks.db
    .prepare('UPDATE workspace_wallets SET archived=1,revision=2')
    .run();
  const recovered = await post({ action: 'recover', id: row.id });
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({
    withdrawal: {
      state: 'finalized',
      receipt: {
        signature: f.signed.signature,
        amountRaw: '10000000',
        networkFeeLamports: '5000',
        signatureVerified: true,
      },
    },
  });
  expect(await lock()).toBeNull();
  const events = await mocks.db
    .prepare('SELECT state FROM native_withdrawal_events ORDER BY sequence')
    .all<{ state: string }>();
  expect(events.results.map((e) => e.state)).toEqual([
    'awaiting_signature',
    'signing',
    'signed',
    'submitted',
    'finalized',
  ]);
  expect((await post({ action: 'recover', id: row.id })).status).toBe(200);
  expect((await get()).status).toBe(200);
  mocks.user = { userId: 'bob' };
  expect((await post({ action: 'recover', id: row.id })).status).toBe(404);
  expect(await (await get()).json()).toMatchObject({
    withdrawals: [],
    active: null,
  });
});
it('keeps unknown send outcomes reserved without retry and only releases an exact finalized failure', async () => {
  const row = await registered();
  mocks.rpc.mockImplementation(async (_endpoint, method) => {
    if (method === 'sendTransaction') throw new Error('timeout');
    return method === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : null;
  });
  expect(
    (
      await post({
        action: 'submit',
        id: row.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(502);
  expect(await lock()).toEqual({ scope: 'withdrawal', state: 'submitted' });
  expect(
    (
      await post({
        action: 'submit',
        id: row.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(409);
  expect((await post({ action: 'recover', id: row.id })).status).toBe(409);
  mocks.rpc.mockImplementation(async (_endpoint, method) =>
    method === 'getGenesisHash'
      ? SOLANA_MAINNET_GENESIS
      : {
          ...f.receipt,
          meta: {
            ...f.receipt.meta,
            err: { InstructionError: [0, 'InsufficientFunds'] },
            postBalances: ['19995000', '0', '1'],
          },
        },
  );
  expect((await post({ action: 'recover', id: row.id })).status).toBe(200);
  expect(await lock()).toBeNull();
  expect(
    mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
  ).toHaveLength(1);
});
it('coordinates swap and withdrawal reservations in both directions including INSERT OR IGNORE', async () => {
  const row = await prepared();
  const insert = () =>
    mocks.db
      .prepare(
        "INSERT OR IGNORE INTO warmup_signing_intents VALUES(?,?,?,?,?,'awaiting_signature',NULL,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        'alice',
        crypto.randomUUID(),
        f.wallet,
        '{}',
        'now',
        'now',
      )
      .run();
  await expect(insert()).rejects.toThrow('Wallet already reserved');
  expect(
    await mocks.db
      .prepare('SELECT COUNT(*) AS n FROM solana_swap_reservations')
      .first(),
  ).toEqual({ n: 0 });
  expect((await post({ action: 'cancel', id: row.id })).status).toBe(200);
  await insert();
  expect(await lock()).toEqual({
    scope: 'warmup',
    state: 'awaiting_signature',
  });
  expect(
    (
      await post({
        action: 'prepare',
        wallet: f.wallet,
        walletRevision: 1,
        recipient: f.recipient,
        amount: '0.01',
      })
    ).status,
  ).toBe(409);
  await mocks.db
    .prepare("UPDATE warmup_signing_intents SET state='cancelled'")
    .run();
  expect(await lock()).toBeNull();
});
it('blocks cancellation during signing and permits signature retention after review expiry or wallet changes', async () => {
  const row = await prepared();
  expect(
    (
      await post({
        action: 'register',
        id: row.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(409);
  expect((await post({ action: 'begin_signing', id: row.id })).status).toBe(
    200,
  );
  expect((await post({ action: 'cancel', id: row.id })).status).toBe(409);
  expect((await post({ action: 'reject_signing', id: row.id })).status).toBe(
    409,
  );
  await mocks.db
    .prepare('UPDATE workspace_wallets SET archived=1,revision=2')
    .run();
  const spy = vi
    .spyOn(Date, 'now')
    .mockReturnValue(Date.parse(row.document.expiresAt) + 1);
  try {
    expect(
      (
        await post({
          action: 'register',
          id: row.id,
          transaction: f.signed.transaction,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post({
          action: 'submit',
          id: row.id,
          transaction: f.signed.transaction,
        })
      ).status,
    ).toBe(409);
  } finally {
    spy.mockRestore();
  }
  expect(await lock()).toEqual({ scope: 'withdrawal', state: 'signed' });
  expect(
    mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
  ).toHaveLength(0);
  expect((await post({ action: 'recover', id: row.id })).status).toBe(200);
});
it('rolls back submission and finalization when immutable event persistence fails', async () => {
  const row = await registered();
  const reject = async (state: string) =>
    mocks.db
      .prepare(
        `CREATE TRIGGER event_reject BEFORE INSERT ON native_withdrawal_events WHEN NEW.state='${state}' BEGIN SELECT RAISE(ABORT,'test event failure'); END`,
      )
      .run();
  await reject('submitted');
  expect(
    (
      await post({
        action: 'submit',
        id: row.id,
        transaction: f.signed.transaction,
      })
    ).status,
  ).toBe(503);
  expect(await lock()).toEqual({ scope: 'withdrawal', state: 'signed' });
  expect(
    mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
  ).toHaveLength(0);
  await mocks.db.prepare('DROP TRIGGER event_reject').run();
  await reject('finalized');
  expect((await post({ action: 'recover', id: row.id })).status).toBe(503);
  expect(await lock()).toEqual({ scope: 'withdrawal', state: 'signed' });
  expect(
    await mocks.db.prepare('SELECT receipt FROM native_withdrawals').first(),
  ).toEqual({ receipt: null });
  await mocks.db.prepare('DROP TRIGGER event_reject').run();
  expect((await post({ action: 'recover', id: row.id })).status).toBe(200);
  await expect(
    mocks.db.prepare("UPDATE native_withdrawals SET document='{}'").run(),
  ).rejects.toThrow('immutable');
  await expect(
    mocks.db.prepare('DELETE FROM native_withdrawals').run(),
  ).rejects.toThrow('retained');
});
it('requires explicit verification to release a rejected signing session and bounds history cursors', async () => {
  const row = await prepared();
  await post({ action: 'begin_signing', id: row.id });
  expect(await lock()).toEqual({ scope: 'withdrawal', state: 'signing' });
  expect(
    (
      await post({
        action: 'reject_signing',
        id: row.id,
        noSignatureVerified: true,
      })
    ).status,
  ).toBe(200);
  expect(await lock()).toBeNull();
  expect((await get('&cursor=' + crypto.randomUUID())).status).toBe(400);
  expect((await get('&cursor=bad')).status).toBe(400);
  mocks.user = null;
  expect((await get()).status).toBe(401);
  expect((await post({ action: 'prepare' })).status).toBe(401);
});

it('atomically rejects a roster revision change immediately before preparation retention or signing claim', async () => {
  const real = mocks.db;
  function race(prefix: string) {
    mocks.db = new Proxy(real, {
      get(target, property) {
        if (property !== 'prepare') return Reflect.get(target, property);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith(prefix)) return statement;
          return new Proxy(statement, {
            get(inner, method) {
              if (method !== 'bind') return Reflect.get(inner, method);
              return (...args: unknown[]) => {
                const bound = inner.bind(...args);
                return new Proxy(bound, {
                  get(query, operation) {
                    if (operation !== 'first')
                      return Reflect.get(query, operation);
                    return async () => {
                      await real
                        .prepare(
                          'UPDATE workspace_wallets SET revision=revision+1',
                        )
                        .run();
                      return query.first();
                    };
                  },
                });
              };
            },
          });
        };
      },
    });
  }
  try {
    race(
      'INSERT INTO native_withdrawals (id,owner_id,wallet_address,wallet_revision,document,state,signature,receipt,created_at,updated_at) SELECT',
    );
    const response = await post({
      action: 'prepare',
      wallet: f.wallet,
      walletRevision: 1,
      recipient: f.recipient,
      amount: '0.01',
    });
    expect(response.status).toBe(409);
    expect(
      await real.prepare('SELECT id FROM native_withdrawals').first(),
    ).toBeNull();
    mocks.db = real;
    await real.prepare('UPDATE workspace_wallets SET revision=1').run();
    const row = await prepared();
    race("UPDATE native_withdrawals SET state='signing'");
    expect((await post({ action: 'begin_signing', id: row.id })).status).toBe(
      409,
    );
    expect(
      await real.prepare('SELECT state FROM native_withdrawals').first(),
    ).toEqual({ state: 'awaiting_signature' });
  } finally {
    mocks.db = real;
  }
});

it('retains returned signatures across workflows and rejects replay registration', async () => {
  const row = await registered();
  expect(
    await mocks.db
      .prepare('SELECT scope,signature FROM solana_execution_signatures')
      .first(),
  ).toEqual({ scope: 'withdrawal', signature: f.signed.signature });
  await expect(
    mocks.db
      .prepare('INSERT INTO solana_swap_signatures VALUES(?,?,?,?)')
      .bind('alice', f.signed.signature, 'warmup', crypto.randomUUID())
      .run(),
  ).rejects.toThrow('Signature already registered');
  expect(
    await mocks.db
      .prepare('SELECT signature FROM solana_swap_signatures')
      .first(),
  ).toBeNull();
  expect((await post({ action: 'recover', id: row.id })).status).toBe(200);
  expect(await lock()).toBeNull();
  expect(
    await mocks.db
      .prepare('SELECT signature FROM solana_execution_signatures')
      .first(),
  ).toEqual({ signature: f.signed.signature });
});

it.each([false, true])(
  'retains and independently recovers exact token units and ATA rent through the owned signing pipeline with Token-2022 fee=%s',
  async (withFee) => {
    const token = await tokenWithdrawalFixture(false, withFee, withFee);
    mocks.fetcher = token.fetcher;
    const preparedResponse = await post({
      action: 'prepare',
      wallet: token.wallet,
      walletRevision: 1,
      recipient: token.recipient,
      amount: token.review.amount,
      mint: token.mint,
      decimals: 6,
    });
    expect(preparedResponse.status).toBe(200);
    const { withdrawal: row } = (await preparedResponse.json()) as {
      withdrawal: NativeWithdrawal;
    };
    expect(row.document.token!.mint).toBe(token.mint);
    expect((await post({ action: 'begin_signing', id: row.id })).status).toBe(
      200,
    );
    expect(
      (
        await post({
          action: 'register',
          id: row.id,
          transaction: token.signed.transaction,
        })
      ).status,
    ).toBe(200);
    mocks.rpc.mockImplementation(async (_endpoint, method) =>
      method === 'getGenesisHash'
        ? SOLANA_MAINNET_GENESIS
        : method === 'sendTransaction'
          ? token.signed.signature
          : method === 'getTransaction'
            ? parseBalanceJson(JSON.stringify(token.receipt))
            : null,
    );
    expect(
      (
        await post({
          action: 'submit',
          id: row.id,
          transaction: token.signed.transaction,
        })
      ).status,
    ).toBe(200);
    await mocks.db
      .prepare('UPDATE workspace_wallets SET archived=1,revision=2')
      .run();
    const recovered = await post({ action: 'recover', id: row.id });
    expect(recovered.status).toBe(200);
    const saved = ((await recovered.json()) as { withdrawal: NativeWithdrawal })
      .withdrawal;
    expect(saved.state).toBe('finalized');
    expect(saved.receipt!.token!.destinationChangeRaw).toBe(
      withFee ? '9007199254740893' : '9007199254740993',
    );
    expect(saved.receipt!.token!.transferFeeRaw).toBe(
      withFee ? '100' : undefined,
    );
    if (withFee) {
      const response = await activity();
      expect(response.status).toBe(200);
      if (process.env.WITHDRAWAL_ACTIVITY_QA_EXPORT === '1') {
        await mkdir(
          new URL('../../../../work/withdrawal-activity-qa/', import.meta.url),
          { recursive: true },
        );
        await writeFile(
          new URL(
            '../../../../work/withdrawal-activity-qa/fixture.json',
            import.meta.url,
          ),
          JSON.stringify(await response.json(), null, 2),
        );
      }
    }
    expect(saved.receipt!.token!.accountRentLamports).toBe(
      withFee ? '2157600' : '2039280',
    );
    expect(await lock()).toBeNull();
    expect((await get()).status).toBe(200);
    expect(
      mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
    ).toHaveLength(1);
    expect(
      (
        await post({
          action: 'submit',
          id: row.id,
          transaction: token.signed.transaction,
        })
      ).status,
    ).toBe(409);
  },
);
it('withholds token submission when the fresh mint precision differs and preserves the registered recovery signature', async () => {
  const token = await tokenWithdrawalFixture();
  mocks.fetcher = token.fetcher;
  const response = await post({
    action: 'prepare',
    wallet: token.wallet,
    walletRevision: 1,
    recipient: token.recipient,
    amount: token.review.amount,
    mint: token.mint,
    decimals: 6,
  });
  const { withdrawal: row } = (await response.json()) as {
    withdrawal: NativeWithdrawal;
  };
  await post({ action: 'begin_signing', id: row.id });
  await post({
    action: 'register',
    id: row.id,
    transaction: token.signed.transaction,
  });
  const accounts = token.data.getMultipleAccounts as {
    value: { data: string[] }[];
  };
  const bytes = Uint8Array.from(atob(accounts.value[1].data[0]), (c) =>
    c.charCodeAt(0),
  );
  bytes[44] = 5;
  accounts.value[1].data[0] = btoa(String.fromCharCode(...bytes));
  expect(
    (
      await post({
        action: 'submit',
        id: row.id,
        transaction: token.signed.transaction,
      })
    ).status,
  ).toBe(502);
  expect(await lock()).toEqual({ scope: 'withdrawal', state: 'signed' });
  expect(
    mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
  ).toHaveLength(0);
  expect((await get()).status).toBe(200);
});
it('exposes captured withdrawal transitions without projecting later receipts into earlier events, including archived wallets', async () => {
  const row = await registered();
  await post({
    action: 'submit',
    id: row.id,
    transaction: f.signed.transaction,
  });
  await post({ action: 'recover', id: row.id });
  await mocks.db
    .prepare('UPDATE workspace_wallets SET archived=1,revision=2')
    .run();
  const response = await activity();
  expect(response.status).toBe(200);
  const data = (await response.json()) as {
    events: {
      sequence: number;
      createdAt: string;
      withdrawal: NativeWithdrawal;
    }[];
    nextCursor: string | null;
  };
  expect(data.events.map((e) => e.withdrawal.state)).toEqual([
    'finalized',
    'submitted',
    'signed',
    'signing',
    'awaiting_signature',
  ]);
  expect(data.events[0].withdrawal.receipt!.signature).toBe(f.signed.signature);
  expect(data.events.slice(1).every((e) => e.withdrawal.receipt === null)).toBe(
    true,
  );
  expect(
    data.events
      .filter((e) =>
        ['signing', 'awaiting_signature'].includes(e.withdrawal.state),
      )
      .every((e) => e.withdrawal.signature === null),
  ).toBe(true);
  expect(
    data.events.every(
      (e) =>
        e.withdrawal.document.sha256 === row.document.sha256 &&
        e.withdrawal.walletRevision === 1,
    ),
  ).toBe(true);
  expect(data.nextCursor).toBeNull();
  mocks.user = { userId: 'bob' };
  expect(await (await activity()).json()).toEqual({
    events: [],
    nextCursor: null,
  });
  mocks.user = null;
  expect((await activity()).status).toBe(401);
});
it('paginates equal-time withdrawal events with owner and wallet bound cursors and rejects invalid retained evidence', async () => {
  const at = f.review.preparedAt,
    statements: D1PreparedStatement[] = [];
  for (let i = 0; i < 27; i++) {
    const id = crypto.randomUUID(),
      review = { ...f.review, id };
    statements.push(
      mocks.db
        .prepare(
          "INSERT INTO native_withdrawals (id,owner_id,wallet_address,wallet_revision,document,state,signature,receipt,created_at,updated_at) VALUES(?,?,?,?,?,'awaiting_signature',NULL,NULL,?,?)",
        )
        .bind(id, 'alice', f.wallet, 1, JSON.stringify(review), at, at),
    );
    statements.push(
      mocks.db
        .prepare("UPDATE native_withdrawals SET state='cancelled' WHERE id=?")
        .bind(id),
    );
  }
  await mocks.db.batch(statements);
  const first = (await (await activity()).json()) as {
    events: { sequence: number }[];
    nextCursor: string;
  };
  expect(first.events).toHaveLength(50);
  expect(first.nextCursor).toBeTruthy();
  const second = (await (
    await activity('?cursor=' + first.nextCursor)
  ).json()) as { events: { sequence: number }[]; nextCursor: null };
  expect(second.events).toHaveLength(4);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set([...first.events, ...second.events].map((e) => e.sequence)).size,
  ).toBe(54);
  expect(
    (await activity('?cursor=' + first.nextCursor + '&wallet=' + f.recipient))
      .status,
  ).toBe(400);
  mocks.user = { userId: 'bob' };
  expect((await activity('?cursor=' + first.nextCursor)).status).toBe(400);
  mocks.user = { userId: 'alice' };
  for (const query of [
    '?cursor=0',
    '?cursor=01',
    '?cursor=9007199254740992',
    '?wallet=bad',
  ])
    expect((await activity(query)).status).toBe(400);
  // Test database only: corrupt the review to verify a fail-closed read without modifying production data.
  await mocks.db.prepare('DROP TRIGGER native_withdrawal_identity').run();
  await mocks.db
    .prepare(
      "UPDATE native_withdrawals SET document=json_set(document,'$.amountRaw','2')",
    )
    .run();
  expect((await activity()).status).toBe(503);
}, 30000);

it('enriches an older failed record without rewriting captured events or sending, and freezes exact evidence', async () => {
  const row = await registered();
  await mocks.db
    .prepare(
      "UPDATE native_withdrawals SET state='failed',updated_at=? WHERE id=?",
    )
    .bind(new Date().toISOString(), row.id)
    .run();
  await mocks.db.prepare('UPDATE workspace_wallets SET archived=1').run();
  const failure = {
    ...f.receipt,
    meta: {
      ...f.receipt.meta,
      err: { InstructionError: ['0', { Custom: '42' }] },
      postBalances: ['19995000', '0', '1'],
    },
  };
  mocks.rpc.mockImplementation(async (_endpoint, method) =>
    method === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : failure,
  );
  const before = (await (await activity()).json()) as {
    events: import('@/lib/withdrawal-activity').WithdrawalActivityEvent[];
  };
  const recovered = await post({ action: 'recover', id: row.id });
  expect(recovered.status).toBe(200);
  const saved = ((await recovered.json()) as { withdrawal: NativeWithdrawal })
    .withdrawal;
  expect(saved.failureReceipt).toMatchObject({
    failed: true,
    networkFeeLamports: '5000',
    walletChangeRaw: '-5000',
    error: {
      type: 'InstructionError',
      instructionIndex: 0,
      instructionCode: 'Custom',
      customCode: 42,
    },
  });
  expect(saved.receipt).toBeNull();
  const after = (await (await activity()).json()) as {
    events: import('@/lib/withdrawal-activity').WithdrawalActivityEvent[];
  };
  expect(after.events.length).toBe(before.events.length + 1);
  expect(after.events[0].withdrawal.failureReceipt).toEqual(
    saved.failureReceipt,
  );
  expect(after.events.slice(1)).toEqual(before.events);
  if (process.env.WITHDRAWAL_FAILURE_QA_EXPORT === '1') {
    const dir = new URL(
      '../../../../work/withdrawal-failure-qa/',
      import.meta.url,
    );
    await mkdir(dir, { recursive: true });
    await writeFile(
      new URL('fixture.json', dir),
      JSON.stringify(after),
      'utf8',
    );
  }

  expect(await lock()).toBeNull();
  expect(
    mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
  ).toHaveLength(0);
  await expect(
    mocks.db
      .prepare('UPDATE native_withdrawals SET failure_receipt=NULL WHERE id=?')
      .bind(row.id)
      .run(),
  ).rejects.toThrow();
  const calls = mocks.rpc.mock.calls.length;
  expect((await post({ action: 'recover', id: row.id })).status).toBe(200);
  expect(mocks.rpc.mock.calls.length).toBe(calls);
});

it('rolls back failed outcome and lock release if immutable failure Activity persistence fails', async () => {
  const row = await registered();
  mocks.rpc.mockImplementation(async (_endpoint, method) =>
    method === 'getGenesisHash'
      ? SOLANA_MAINNET_GENESIS
      : {
          ...f.receipt,
          meta: {
            ...f.receipt.meta,
            postBalances: ['19995000', '0', '1'],
            err: 'InsufficientFundsForFee',
          },
        },
  );
  await mocks.db
    .prepare(
      "CREATE TRIGGER event_reject BEFORE INSERT ON native_withdrawal_events WHEN NEW.state='failed' BEGIN SELECT RAISE(ABORT,'test failure evidence event'); END",
    )
    .run();
  expect((await post({ action: 'recover', id: row.id })).status).toBe(503);
  expect(
    await mocks.db
      .prepare(
        'SELECT state,failure_receipt FROM native_withdrawals WHERE id=?',
      )
      .bind(row.id)
      .first(),
  ).toEqual({ state: 'signed', failure_receipt: null });
  expect(await lock()).toEqual({ scope: 'withdrawal', state: 'signed' });
  await mocks.db.prepare('DROP TRIGGER event_reject').run();
  expect((await post({ action: 'recover', id: row.id })).status).toBe(200);
  expect(await lock()).toBeNull();
  expect(
    mocks.rpc.mock.calls.filter((c) => c[1] === 'sendTransaction'),
  ).toHaveLength(0);
});
