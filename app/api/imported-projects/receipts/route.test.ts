import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { mkdirSync, writeFileSync } from 'node:fs';
import bs58 from 'bs58';
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
const projectId = '00000000-0000-4000-8000-000000000001',
  mint = bs58.encode(new Uint8Array(32).fill(2));
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const wallet = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
async function insert(
  n: number,
  side: 'Buy' | 'Sell',
  slot: number,
  w = 3,
  owner = 'one',
) {
  const doc = {
    network: 'mainnet',
    mint,
    decimals: 6,
    preparationSha256: 'a'.repeat(64),
    signature: bs58.encode(new Uint8Array(64).fill(n)),
    wallet: wallet(w),
    signatureVerified: true,
    commitment: 'finalized',
    side,
    tokenUnitsRaw: side === 'Buy' ? '100' : '1',
    source: 'provider.test',
    observedAt: '2026-10-11T00:00:00.000Z',
    slot,
    blockTime: null,
    networkFeeLamports: '1',
    nativeChangeRaw: side === 'Buy' ? '-101' : '4',
    rentChangeRaw: '0',
    nativeSettlementRaw: side === 'Buy' ? '-100' : '5',
  };
  await mocks.db
    .prepare('INSERT INTO imported_swap_receipts VALUES(?,?,?,?,?,?,?,?)')
    .bind(
      owner,
      projectId,
      id(n),
      id(n + 100),
      1,
      1,
      '2026-10-11T00:00:00.000Z',
      JSON.stringify(doc),
    )
    .run();
}
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'imported-performance',
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
          env: { DB: { type: 'd1', id: 'imported-performance' } },
        },
      },
    ],
  });
  mocks.db = (await mf.getD1Database(
    'DB',
    'imported-performance',
  )) as unknown as D1Database;
  await mocks.db
    .prepare(
      'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,document TEXT,archived INTEGER)',
    )
    .run();
  await mocks.db
    .prepare(
      'CREATE TABLE imported_swap_receipts(owner_id TEXT,project_id TEXT,id TEXT,preparation_id TEXT,project_revision INTEGER,wallet_revision INTEGER,created_at TEXT,document TEXT)',
    )
    .run();
  await mocks.db
    .prepare(
      'INSERT INTO imported_token_projects(owner_id,id,document,archived) VALUES(?,?,?,1)',
    )
    .bind(
      'one',
      projectId,
      JSON.stringify({
        token: { chain: 'Solana', address: mint, decimals: 6 },
      }),
    )
    .run();
  await insert(1, 'Buy', 1);
  for (let n = 2; n <= 56; n++) await insert(n, 'Sell', n);
  await insert(90, 'Sell', 90, 4, 'other');
});
afterAll(async () => {
  await mf?.dispose();
});
const read = (suffix = '') =>
  GET(
    new Request(
      `http://localhost/api/imported-projects/receipts?projectId=${projectId}${suffix}`,
    ),
  );
it('isolates owners and includes complete performance beyond the 50-receipt page and across archives', async () => {
  expect((await read()).status).toBe(401);
  mocks.user = { userId: 'other' };
  expect((await read()).status).toBe(404);
  mocks.user = { userId: 'one' };
  const r = await read();
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  const p = (await r.json()) as {
    receipts: unknown[];
    nextCursor: string;
    performance: unknown;
  };
  expect(p.receipts).toHaveLength(50);
  expect(p.performance).toMatchObject({
    receiptCount: 56,
    matchedSoldRaw: '55',
    unknownBasisSoldRaw: '0',
    realizedCostLamports: '55',
    realizedResultLamports: '165',
    openCostLamports: '46',
  });
  const older = (await (
    await read(`&cursor=${p.nextCursor}`)
  ).json()) as typeof p;
  expect(older.receipts).toHaveLength(6);
  expect(older.performance).toEqual(p.performance);
  expect((await read('&cursor=' + id(90))).status).toBe(400);
  const csv = await read('&format=csv');
  expect(csv.status).toBe(200);
  expect((await csv.text()).split('\r\n')).toHaveLength(58);
  if (process.env.IMPORTED_PERFORMANCE_QA_EXPORT === '1') {
    mkdirSync('work/imported-performance-qa', { recursive: true });
    writeFileSync(
      'work/imported-performance-qa/covered.json',
      JSON.stringify(p),
    );
  }
});
it('reports unknown basis and same-slot ordering separately instead of publishing an aggregate gain', async () => {
  mocks.user = { userId: 'one' };
  await insert(57, 'Sell', 57, 4);
  await insert(58, 'Buy', 58, 5);
  await insert(59, 'Sell', 58, 5);
  const r = await read();
  expect(r.status).toBe(200);
  const p = await r.json();
  expect(p).toMatchObject({
    performance: {
      unknownBasisSoldRaw: '1',
      unresolvedSoldRaw: '1',
      realizedResultLamports: null,
      openCostLamports: null,
    },
  });
  if (process.env.IMPORTED_PERFORMANCE_QA_EXPORT === '1')
    writeFileSync(
      'work/imported-performance-qa/incomplete.json',
      JSON.stringify(p),
    );
});
it('returns complete bounded coverage for more than 50 wallets', async () => {
  mocks.user = { userId: 'one' };
  for (let n = 100; n < 151; n++) await insert(n, 'Buy', n, n - 80);
  const r = await read();
  expect(r.status).toBe(200);
  const p = (await r.json()) as {
    performance: { wallets: unknown[] };
    receipts: unknown[];
  };
  expect(p.performance.wallets).toHaveLength(54);
  expect(p.receipts).toHaveLength(50);
  if (process.env.IMPORTED_PERFORMANCE_QA_EXPORT === '1')
    writeFileSync(
      'work/imported-performance-qa/paginated.json',
      JSON.stringify(p),
    );
});
it('rejects damaged receipts and returns no partial summary or performance', async () => {
  mocks.user = { userId: 'one' };
  await mocks.db
    .prepare(
      "UPDATE imported_swap_receipts SET document=json_set(document,'$.networkFeeLamports','bad') WHERE owner_id='one' AND id=?",
    )
    .bind(id(1))
    .run();
  const r = await read();
  expect(r.status).toBe(503);
  expect(await r.json()).not.toHaveProperty('performance');
});
