import { beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import bs58 from 'bs58';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { AccountCosts } from '@/lib/account-costs';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET } from './route';
import { nativeWithdrawalFixture } from '../../../test/native-withdrawal-fixture';
import { decodeNativeWithdrawalReceipt } from '@/lib/native-withdrawal-server';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const signature = (n: number) => bs58.encode(new Uint8Array(64).fill(n));
let mf: Miniflare;
const date = '2026-10-11T00:00:00Z';
const tables = [
  'imported_token_projects(owner_id TEXT,id TEXT,document TEXT,archived INTEGER)',
  'imported_swap_receipts(owner_id TEXT,project_id TEXT,id TEXT,preparation_id TEXT,project_revision INTEGER,wallet_revision INTEGER,created_at TEXT,document TEXT)',
  'warmup_buy_receipts(owner_id TEXT,id TEXT,plan_id TEXT,signature TEXT,document TEXT,plan_revision INTEGER,wallet_revision INTEGER,cycle INTEGER,wallet_address TEXT,remaining_raw TEXT)',
  'warmup_sell_receipts(owner_id TEXT,id TEXT,plan_id TEXT,signature TEXT,document TEXT,buy_receipt_id TEXT,consumed_raw TEXT)',
  ...['imported_swap_signing_intents', 'warmup_signing_intents'].map(
    (t) =>
      `${t}(owner_id TEXT,id TEXT,wallet_address TEXT,signature TEXT,state TEXT,document TEXT,failure_receipt TEXT)`,
  ),
  'native_withdrawals(owner_id TEXT,id TEXT,wallet_address TEXT,wallet_revision INTEGER,state TEXT,signature TEXT,document TEXT,receipt TEXT,failure_receipt TEXT,created_at TEXT,updated_at TEXT)',
];
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'account-cost-tests',
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
          env: { DB: { type: 'd1', id: 'account-costs-test-only' } },
        },
      },
    ],
  });
  mocks.db = await mf.getD1Database('DB', 'account-cost-tests');
  for (const table of tables)
    await mocks.db.prepare(`CREATE TABLE ${table}`).run();
});
afterAll(async () => mf?.dispose());
async function trade(n: number, owner = 'one') {
  const document = {
    network: 'mainnet',
    commitment: 'finalized',
    signatureVerified: true,
    signature: signature(n),
    wallet: key(2),
    mint: key(3),
    decimals: 6,
    preparationSha256: 'a'.repeat(64),
    side: 'Buy',
    tokenUnitsRaw: '1',
    source: 'provider.test',
    observedAt: date,
    slot: n,
    blockTime: null,
    networkFeeLamports: '1',
    nativeChangeRaw: '-101',
    rentChangeRaw: '0',
    nativeSettlementRaw: '-100',
  };
  await mocks.db
    .prepare('INSERT INTO imported_swap_receipts VALUES(?,?,?,?,?,?,?,?)')
    .bind(
      owner,
      id(1),
      id(n),
      id(n + 100),
      1,
      1,
      date,
      JSON.stringify(document),
    )
    .run();
}
async function approval(
  n: number,
  state = 'failed',
  proof = true,
  table = 'warmup_signing_intents',
) {
  const document = {
    id: id(n),
    wallet: key(2),
    network: 'mainnet',
    sha256: 'b'.repeat(64),
    inputMint: key(3),
    outputMint: key(4),
    inputRaw: '1',
    minimumOutputRaw: '2',
    maximumFeeLamports: '5000',
  };
  const failure = {
    failed: true,
    network: 'mainnet',
    commitment: 'finalized',
    signatureVerified: true,
    signature: signature(n),
    wallet: key(2),
    sha256: document.sha256,
    inputMint: key(3),
    outputMint: key(4),
    inputRaw: '1',
    minimumOutputRaw: '2',
    reviewedFeeLamports: '5000',
    networkFeeLamports: '5001',
    walletChangeRaw: '-5001',
    feeLimitExceeded: true,
    slot: 100,
    blockTime: null,
    error: { type: 'AccountNotFound' },
    observedAt: date,
    source: 'provider.test',
  };
  await mocks.db
    .prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?,?,?)`)
    .bind(
      'one',
      id(n),
      key(2),
      signature(n),
      state,
      JSON.stringify(document),
      proof ? JSON.stringify(failure) : null,
    )
    .run();
}
beforeEach(async () => {
  mocks.user = { userId: 'one' };
  for (const table of tables)
    await mocks.db.prepare(`DELETE FROM ${table.split('(')[0]}`).run();
  await mocks.db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,1)')
    .bind(
      'one',
      id(1),
      JSON.stringify({
        token: { chain: 'Solana', address: key(3), decimals: 6 },
      }),
    )
    .run();
});
it('isolates owners and includes all receipts beyond one display page, including archived projects', async () => {
  mocks.user = null;
  expect((await GET()).status).toBe(401);
  mocks.user = { userId: 'one' };
  await mocks.db.batch(
    Array.from({ length: 56 }, (_, i) => {
      const n = i + 1;
      const d = {
        network: 'mainnet',
        commitment: 'finalized',
        signatureVerified: true,
        signature: signature(n),
        wallet: key(2),
        mint: key(3),
        decimals: 6,
        preparationSha256: 'a'.repeat(64),
        side: 'Buy',
        tokenUnitsRaw: '1',
        source: 'provider.test',
        observedAt: date,
        slot: n,
        blockTime: null,
        networkFeeLamports: '1',
        nativeChangeRaw: '-101',
        rentChangeRaw: '0',
        nativeSettlementRaw: '-100',
      };
      return mocks.db
        .prepare('INSERT INTO imported_swap_receipts VALUES(?,?,?,?,?,?,?,?)')
        .bind('one', id(1), id(n), id(n + 100), 1, 1, date, JSON.stringify(d));
    }),
  );
  await trade(90, 'other');
  await approval(100);
  await approval(101, 'failed', true, 'imported_swap_signing_intents');
  await approval(102, 'failed', false);
  await approval(103, 'submitted', false);
  await approval(104, 'finalized', false);
  const r = await GET();
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  const body = (await r.json()) as AccountCosts;
  expect(body).toMatchObject({
    receiptCount: 58,
    successfulFeeLamports: '56',
    failedFeeLamports: '10002',
    totalFeeLamports: '10058',
    pendingCount: 1,
    missingFailureCount: 1,
    missingFinalizedCount: 1,
  });
  mkdirSync('work/account-costs-qa', { recursive: true });
  writeFileSync(
    'work/account-costs-qa/fixture.json',
    JSON.stringify(body, null, 2),
  );
  mocks.user = { userId: 'empty' };
  expect(await (await GET()).json()).toMatchObject({
    receiptCount: 0,
    totalFeeLamports: '0',
  });
});
it('validates linked warmup lots across plans and rejects a sell moved to another plan', async () => {
  const doc = {
    network: 'mainnet',
    commitment: 'finalized',
    signatureVerified: true,
    signature: signature(110),
    wallet: key(2),
    mint: key(3),
    decimals: 6,
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    slot: 100,
    preparationSha256: 'a'.repeat(64),
    acquiredRaw: '3',
    networkFeeLamports: '5',
    rentChangeRaw: '20',
    nativeSettlementRaw: '-100',
  };
  await mocks.db
    .prepare('INSERT INTO warmup_buy_receipts VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind(
      'one',
      id(110),
      id(1),
      doc.signature,
      JSON.stringify(doc),
      1,
      1,
      1,
      key(2),
      '2',
    )
    .run();
  const sold = {
    ...doc,
    signature: signature(111),
    slot: 101,
    consumedRaw: '1',
    buyReceiptId: id(110),
    nativeSettlementRaw: '50',
    networkFeeLamports: '7',
  };
  await mocks.db
    .prepare('INSERT INTO warmup_sell_receipts VALUES(?,?,?,?,?,?,?)')
    .bind(
      'one',
      id(111),
      id(1),
      sold.signature,
      JSON.stringify(sold),
      id(110),
      '1',
    )
    .run();
  expect(await (await GET()).json()).toMatchObject({
    receiptCount: 2,
    totalFeeLamports: '12',
  });
  await mocks.db
    .prepare('UPDATE warmup_sell_receipts SET plan_id=?')
    .bind(id(2))
    .run();
  expect((await GET()).status).toBe(503);
});
it('rejects corrupt failure evidence and duplicate signatures across workflows without returning partial totals', async () => {
  await trade(1);
  await approval(1);
  expect((await GET()).status).toBe(503);
  await mocks.db.prepare('DELETE FROM warmup_signing_intents').run();
  await approval(100);
  await mocks.db
    .prepare(
      "UPDATE warmup_signing_intents SET failure_receipt=json_set(failure_receipt,'$.walletChangeRaw','-1')",
    )
    .run();
  const r = await GET();
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({
    error: 'Account costs unavailable. No partial totals are shown.',
  });
});
it('does not truncate a ledger exceeding capacity', async () => {
  await trade(1);
  await mocks.db
    .prepare(
      'INSERT INTO imported_swap_receipts SELECT owner_id,project_id,id,preparation_id,project_revision,wallet_revision,created_at,document FROM imported_swap_receipts',
    )
    .run();
  for (let n = 0; n < 11; n++)
    await mocks.db
      .prepare(
        'INSERT INTO imported_swap_receipts SELECT * FROM imported_swap_receipts',
      )
      .run();
  expect((await GET()).status).toBe(503);
});
it('counts verified withdrawal success and failure network fees without expensing the transfer principal', async () => {
  const f = await nativeWithdrawalFixture();
  const receipt = await decodeNativeWithdrawalReceipt(
    f.receipt,
    f.review,
    f.signed.signature,
  );
  const insert = async (state: string, r: unknown, failure: unknown) => {
    await mocks.db.prepare('DELETE FROM native_withdrawals').run();
    await mocks.db
      .prepare('INSERT INTO native_withdrawals VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .bind(
        'one',
        f.review.id,
        f.wallet,
        1,
        state,
        f.signed.signature,
        JSON.stringify(f.review),
        r ? JSON.stringify(r) : null,
        failure ? JSON.stringify(failure) : null,
        date,
        date,
      )
      .run();
  };
  await insert('finalized', receipt, null);
  expect(await (await GET()).json()).toMatchObject({
    receiptCount: 1,
    totalFeeLamports: '5000',
    successfulFeeLamports: '5000',
  });
  const failure = await decodeNativeWithdrawalReceipt(
    {
      ...f.receipt,
      meta: {
        ...f.receipt.meta,
        err: { InstructionError: [0, { Custom: 42 }] },
        postBalances: ['19995000', '0', '1'],
      },
    },
    f.review,
    f.signed.signature,
  );
  await insert('failed', null, failure);
  expect(await (await GET()).json()).toMatchObject({
    receiptCount: 1,
    totalFeeLamports: '5000',
    failedFeeLamports: '5000',
  });
  await insert('failed', null, null);
  expect(await (await GET()).json()).toMatchObject({
    receiptCount: 0,
    totalFeeLamports: '0',
    missingFailureCount: 1,
  });
  await insert('submitted', null, null);
  expect(await (await GET()).json()).toMatchObject({
    receiptCount: 0,
    totalFeeLamports: '0',
    pendingCount: 1,
  });
});
