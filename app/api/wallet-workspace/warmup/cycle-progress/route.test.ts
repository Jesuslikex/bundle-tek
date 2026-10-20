import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import bs58 from 'bs58';
import { mkdirSync, writeFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET } from './route';
let mf: Miniflare;
const wallet = bs58.encode(new Uint8Array(32).fill(1)),
  mint = bs58.encode(new Uint8Array(32).fill(2));
const document = (n: number) => ({
  signatureVerified: true,
  signature: bs58.encode(new Uint8Array(64).fill(n)),
  wallet,
  mint,
  decimals: 6,
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  slot: n,
  preparationSha256: 'a'.repeat(64),
  nativeSettlementRaw: n === 1 ? '-100' : '50',
  networkFeeLamports: '1',
  rentChangeRaw: n === 1 ? '20' : '-10',
  acquiredRaw: '3',
  consumedRaw: '1',
  buyReceiptId: 'lot',
  commitment: 'finalized',
  network: 'mainnet',
});
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'lot-performance',
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
          env: { DB: { type: 'd1', id: 'lot-performance' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'lot-performance',
  )) as unknown as D1Database;
  for (const sql of [
    'CREATE TABLE wallet_warmup_plans(owner_id TEXT,id TEXT,revision INTEGER,archived INTEGER,updated_at TEXT,document TEXT)',
    'CREATE TABLE warmup_buy_receipts(owner_id TEXT,plan_id TEXT,id TEXT,plan_revision INTEGER,wallet_revision INTEGER,cycle INTEGER,wallet_address TEXT,signature TEXT,remaining_raw TEXT,document TEXT)',
    'CREATE TABLE warmup_sell_receipts(owner_id TEXT,plan_id TEXT,id TEXT,buy_receipt_id TEXT,consumed_raw TEXT,signature TEXT,document TEXT)',
    'CREATE TABLE solana_swap_reservations(owner_id TEXT,intent_id TEXT,wallet_address TEXT,state TEXT)',
  ])
    await mocks.db.prepare(sql).run();
  await mocks.db
    .prepare('INSERT INTO wallet_warmup_plans VALUES(?,?,?,?,?,?)')
    .bind(
      'one',
      'qa',
      2,
      1,
      '2026-10-11T00:00:00.000Z',
      JSON.stringify({
        chain: 'Solana',
        cycles: 1,
        addresses: [wallet],
        walletRevisions: [{ address: wallet, revision: 2 }],
        tokens: [mint],
      }),
    )
    .run();
  await mocks.db
    .prepare('INSERT INTO warmup_buy_receipts VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind(
      'one',
      'qa',
      'lot',
      1,
      1,
      1,
      wallet,
      document(1).signature,
      '2',
      JSON.stringify(document(1)),
    )
    .run();
  await mocks.db
    .prepare('INSERT INTO warmup_sell_receipts VALUES(?,?,?,?,?,?,?)')
    .bind(
      'one',
      'qa',
      'sell',
      'lot',
      '1',
      document(2).signature,
      JSON.stringify(document(2)),
    )
    .run();
});
afterAll(async () => {
  await mf?.dispose();
});
const read = (query = 'id=qa&revision=2&includeEarlier=true') =>
  GET(
    new Request(
      `http://localhost/api/wallet-workspace/warmup/cycle-progress?${query}`,
    ),
  );
it('isolates owners, validates revision and includes archived historical lots only on explicit selection', async () => {
  expect((await read()).status).toBe(401);
  mocks.user = { userId: 'two' };
  expect((await read()).status).toBe(404);
  mocks.user = { userId: 'one' };
  expect((await read('id=qa&revision=1')).status).toBe(409);
  expect(await (await read('id=qa&revision=2')).json()).toMatchObject({
    performance: { lotCount: 0 },
  });
  const r = await read();
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  const result = await r.json();
  if (process.env.WARMUP_PERFORMANCE_QA_EXPORT === '1') {
    mkdirSync('work/warmup-performance-qa', { recursive: true });
    writeFileSync(
      'work/warmup-performance-qa/fixture.json',
      JSON.stringify(result),
    );
    writeFileSync(
      'work/warmup-performance-qa/current.json',
      JSON.stringify(await (await read('id=qa&revision=2')).json()),
    );
  }
  expect(result).toMatchObject({
    archived: true,
    executionAllowed: false,
    performance: {
      lotCount: 1,
      realizedResultLamports: '16',
      openCostLamports: '68',
      rentChangeLamports: '10',
      lots: [
        expect.objectContaining({
          buyVolumeLamports: '100',
          sellVolumeLamports: '50',
          sellCount: 1,
        }),
      ],
    },
  });
});
it('rejects damaged economics instead of returning partial performance or inferred completion', async () => {
  mocks.user = { userId: 'one' };
  await mocks.db
    .prepare(
      "UPDATE warmup_sell_receipts SET document=json_set(document,'$.networkFeeLamports','invalid')",
    )
    .run();
  const r = await read();
  expect(r.status).toBe(503);
  expect(await r.json()).not.toHaveProperty('performance');
});
