import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { cleanupFixture } from '../../../../test/wallet-cleanup-fixture';
import bs58 from 'bs58';
import {
  decode,
  signWalletCleanupBatch,
  type WalletCleanup,
  type WalletCleanupReceipt,
  type WalletCleanupReview,
} from '@/lib/wallet-cleanup';
const mocks = vi.hoisted(() => ({
  user: { userId: 'alice' } as { userId: string } | null,
  db: null as unknown as D1Database,
  fetcher: null as unknown as typeof fetch,
  sent: [] as string[],
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
vi.mock('@/lib/wallet-balances', async (original) => {
  const actual = await original<typeof import('@/lib/wallet-balances')>();
  return {
    ...actual,
    balanceRpc: (...args: Parameters<typeof actual.balanceRpc>) =>
      actual.balanceRpc(args[0], args[1], args[2], args[3], mocks.fetcher),
  };
});
vi.mock('@/lib/warmup-swap-quote', async (original) => ({
  ...(await original<typeof import('@/lib/warmup-swap-quote')>()),
  prepareSolanaSwap: (...args: unknown[]) =>
    (f.sell.deps.prepare as (...a: unknown[]) => unknown)(...args),
}));
vi.mock('@/lib/imported-swap-simulation', async (original) => ({
  ...(await original<typeof import('@/lib/imported-swap-simulation')>()),
  simulateImportedSwap: (...args: unknown[]) =>
    (f.sell.deps.simulate as (...a: unknown[]) => unknown)(...args),
}));
import { GET, POST } from './route';
import { env } from '@/lib/server-env';

let mf: Miniflare, f: ReturnType<typeof cleanupFixture>;
let receiptFor: ((transaction: string) => unknown) | null = null;
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'cleanup-test',
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
          env: { DB: { type: 'd1', id: 'cleanup-test-only' } },
        },
      },
    ],
  });
  mocks.db = await mf.getD1Database('DB', 'cleanup-test');
  await mocks.db
    .prepare(
      'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
    )
    .run();
  await mocks.db
    .prepare(
      'CREATE TABLE pump_launch_reviews(owner_id TEXT,payer TEXT,state TEXT,review TEXT)',
    )
    .run();
  for (const name of [
    '0024_imported_token_projects',
    '0041_imported_swap_preparations',
    '0045_warmup_signing_intents',
    '0047_shared_swap_reservations',
    '0049_native_withdrawals',
    '0094_wallet_cleanup',
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
afterAll(async () => mf?.dispose());
beforeEach(async () => {
  mocks.user = { userId: 'alice' };
  mocks.sent = [];
  receiptFor = null;
  await mocks.db.prepare('DROP TRIGGER IF EXISTS wallet_cleanup_delete').run();
  await mocks.db
    .prepare('DROP TRIGGER IF EXISTS native_withdrawal_delete')
    .run();
  for (const table of [
    'wallet_cleanups',
    'native_withdrawals',
    'native_withdrawal_events',
    'solana_execution_reservations',
    'solana_execution_signatures',
    'workspace_wallets',
    'pump_launch_reviews',
  ])
    await mocks.db.prepare(`DELETE FROM ${table}`).run();
  await mocks.db
    .prepare(
      "CREATE TRIGGER wallet_cleanup_delete BEFORE DELETE ON wallet_cleanups BEGIN SELECT RAISE(ABORT,'Cleanup history is retained'); END",
    )
    .run();
  f = cleanupFixture();
  mocks.fetcher = (async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    if (body.method === 'sendTransaction') {
      mocks.sent.push(body.params[0]);
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: bs58.encode(decode(body.params[0]).slice(1, 65)),
      });
    }
    if (body.method === 'getTransaction')
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: receiptFor ? receiptFor(mocks.sent[0]) : null,
      });
    return f.fetcher(url as string, init);
  }) as typeof fetch;
  for (const address of [f.wallet, f.destination])
    await mocks.db
      .prepare("INSERT INTO workspace_wallets VALUES('alice','Solana',?,1,0)")
      .bind(address)
      .run();
});
const post = (body: object) =>
  POST(
    new Request('http://localhost/api/wallet-workspace/cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
type Body = {
  batchId: string;
  cleanups: WalletCleanup[];
  cleanup: WalletCleanup;
  errors: { wallet: string; error: string }[];
};
const body = (response: Response) => response.json() as Promise<Body>;
const prepare = async (extra: object = {}) =>
  post({
    action: 'prepare',
    destination: f.destination,
    wallets: [{ address: f.wallet, revision: 1 }],
    ...extra,
  });

it('runs prepare, batch signing, registration, one submission and finalized recovery', async () => {
  const prepared = await prepare();
  expect(prepared.status).toBe(200);
  const batch = (await body(prepared)) as {
    batchId: string;
    cleanups: WalletCleanup[];
    errors: unknown[];
  };
  expect(batch.errors).toEqual([]);
  expect(batch.cleanups).toHaveLength(1);
  const [row] = batch.cleanups;
  expect((row.document as WalletCleanupReview).close).toHaveLength(3);

  // A wallet in an active cleanup cannot be reserved by another flow.
  await expect(
    mocks.db
      .prepare(
        "INSERT INTO solana_execution_reservations VALUES('alice',?,'withdrawal',?,'awaiting_signature')",
      )
      .bind(f.wallet, crypto.randomUUID())
      .run(),
  ).rejects.toThrow(/reserved for cleanup/);
  const again = await body(await prepare());
  expect(again.cleanups).toEqual([]);
  expect(again.errors[0].error).toMatch(/retained approval/);

  const begun = await post({ action: 'begin_signing', batchId: batch.batchId });
  expect(begun.status).toBe(200);
  expect((await body(begun)).cleanups[0].state).toBe('signing');

  const [signed] = await signWalletCleanupBatch(
    await f.session(f.owner),
    [row.document],
    () => {},
  );
  const submitBeforeRegister = await post({
    action: 'submit',
    id: row.id,
    transaction: signed.transaction,
  });
  expect(submitBeforeRegister.status).toBe(409);
  const registered = await post({
    action: 'register',
    id: row.id,
    transaction: signed.transaction,
  });
  expect((await body(registered)).cleanup).toMatchObject({
    state: 'signed',
    signature: signed.signature,
  });
  const submitted = await post({
    action: 'submit',
    id: row.id,
    transaction: signed.transaction,
  });
  expect((await body(submitted)).cleanup.state).toBe('submitted');
  expect(mocks.sent).toEqual([signed.transaction]);
  const resubmit = await post({
    action: 'submit',
    id: row.id,
    transaction: signed.transaction,
  });
  expect(resubmit.status).toBe(409);
  expect(mocks.sent).toHaveLength(1);

  const pending = await post({ action: 'recover', id: row.id });
  expect(pending.status).toBe(409);
  receiptFor = (tx) => f.receipt(row.document as WalletCleanupReview, tx);
  const recovered = await post({ action: 'recover', id: row.id });
  const final = (await body(recovered)).cleanup as WalletCleanup;
  expect(final.state).toBe('finalized');
  expect((final.receipt as WalletCleanupReceipt).closedAccounts).toBe(3);

  const history = await GET(
    new Request(
      `http://localhost/api/wallet-workspace/cleanup?batchId=${batch.batchId}`,
    ),
  );
  expect((await body(history)).cleanups[0].state).toBe('finalized');
  // Finalized cleanup releases the wallet for other flows.
  await mocks.db
    .prepare(
      "INSERT INTO solana_execution_reservations VALUES('alice',?,'withdrawal',?,'awaiting_signature')",
    )
    .bind(f.wallet, crypto.randomUUID())
    .run();
});

it('refuses tampered signed packets and unsaved destinations', async () => {
  const unknown = await post({
    action: 'prepare',
    destination: 'So11111111111111111111111111111111111111112',
    wallets: [{ address: f.wallet, revision: 1 }],
  });
  expect(unknown.status).toBe(400);
  const batch = await body(await prepare());
  await post({ action: 'begin_signing', batchId: batch.batchId });
  const [genuine] = await signWalletCleanupBatch(
    await f.session(f.owner),
    [batch.cleanups[0].document],
    () => {},
  );
  const tampered =
    genuine.transaction.slice(0, 10) +
    (genuine.transaction[10] === 'A' ? 'B' : 'A') +
    genuine.transaction.slice(11);
  const rejected = await post({
    action: 'register',
    id: batch.cleanups[0].id,
    transaction: tampered,
  });
  expect(rejected.status).toBeGreaterThanOrEqual(400);
  const released = await post({
    action: 'reject_signing',
    id: batch.cleanups[0].id,
    noSignatureVerified: true,
  });
  expect((await body(released)).cleanup.state).toBe('cancelled');
});

it('cancels unsigned batches, reports per-wallet refusals and blocks launch payers', async () => {
  const batch = await body(await prepare());
  await expect(
    mocks.db
      .prepare(
        "INSERT INTO pump_launch_reviews VALUES('alice',?,'review','{}')",
      )
      .bind(f.wallet)
      .run(),
  ).rejects.toThrow(/reserved for cleanup/);
  const cancelled = await post({ action: 'cancel', batchId: batch.batchId });
  expect((await body(cancelled)).cleanups[0].state).toBe('cancelled');

  await mocks.db
    .prepare("INSERT INTO pump_launch_reviews VALUES('alice',?,'review','{}')")
    .bind(f.wallet)
    .run();
  await expect(
    mocks.db
      .prepare(
        "INSERT INTO wallet_cleanups (id,owner_id,batch_id,wallet_address,wallet_revision,destination,document,state,created_at,updated_at) VALUES(?,'alice',?,?,1,?,'{\"format\":\"wallet-cleanup-v1\"}','awaiting_signature','x','x')",
      )
      .bind(crypto.randomUUID(), crypto.randomUUID(), f.wallet, f.destination)
      .run(),
  ).rejects.toThrow(/reserved for launch/);

  await mocks.db.prepare('DELETE FROM pump_launch_reviews').run();
  await mocks.db
    .prepare('UPDATE workspace_wallets SET revision=2 WHERE address=?')
    .bind(f.wallet)
    .run();
  const stale = await body(await prepare());
  expect(stale.errors[0].error).toMatch(/Reload the roster/);

  mocks.user = null;
  expect((await prepare()).status).toBe(401);
});

it('stops before storage when the simulated settlement differs', async () => {
  f.state.simulationDrift = 1n;
  const result = await body(await prepare());
  expect(result.cleanups).toEqual([]);
  expect(result.errors[0].error).toMatch(/settlement/);
});

it('sells leftover tokens as their own reviewed batch, then allows close and sweep', async () => {
  env.JUPITER_API_KEY = 'test-key';
  try {
    const sold = await body(await prepare({ stage: 'sell' }));
    expect(sold).toMatchObject({ errors: [] });
    expect(sold.cleanups).toHaveLength(1);
    const [row] = sold.cleanups;
    expect(row.document.format).toBe('wallet-cleanup-sell-v1');
    const blocked = await body(await prepare());
    expect(blocked.errors[0].error).toMatch(/retained approval/);
    await post({ action: 'begin_signing', batchId: sold.batchId });
    const [signed] = await signWalletCleanupBatch(
      await f.session(f.owner),
      [row.document],
      () => {},
    );
    await post({
      action: 'register',
      id: row.id,
      transaction: signed.transaction,
    });
    const submitted = await body(
      await post({
        action: 'submit',
        id: row.id,
        transaction: signed.transaction,
      }),
    );
    expect(submitted.cleanup.state).toBe('submitted');
    expect(mocks.sent).toEqual([signed.transaction]);
    receiptFor = (tx) => f.sell.receipt(tx);
    const recovered = await body(await post({ action: 'recover', id: row.id }));
    expect(recovered.cleanup.state).toBe('finalized');
    expect(recovered.cleanup.receipt).toMatchObject({
      kind: 'sell',
      soldRaw: '5',
    });
    const closing = await body(await prepare());
    expect(closing.errors).toEqual([]);
    expect(closing.cleanups).toHaveLength(1);
  } finally {
    delete env.JUPITER_API_KEY;
  }
});

it('refuses the sell stage when Jupiter is not configured', async () => {
  const result = await prepare({ stage: 'sell' });
  expect(result.status).toBe(503);
});
