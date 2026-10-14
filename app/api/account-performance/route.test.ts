import { beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import bs58 from 'bs58';
import { jitoPerformanceFixture } from '../../../test/jito-performance-fixture';
import { proposedImportedLotLink } from '@/lib/imported-lot-links';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  acquisitionReceipt,
  acquisitionId as id,
  acquisitionMint as mint,
  acquisitionWallet as wallet,
} from '../../../test/imported-sell-acquisition-fixture';
import {
  accountPerformanceCsv,
  type AccountPerformance,
} from '@/lib/account-performance';
import {
  validatedTimelineData,
  type PerformanceTimelineData,
} from '@/lib/performance-timeline';
const mocks = vi.hoisted(() => ({
  user: null as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET } from './route';
const date = '2026-10-11T00:00:00Z';
const signature = (n: number) => bs58.encode(new Uint8Array(64).fill(n));
const tables = [
  'imported_token_projects(owner_id TEXT,id TEXT,document TEXT,archived INTEGER)',
  'imported_swap_receipts(owner_id TEXT,project_id TEXT,id TEXT,preparation_id TEXT,project_revision INTEGER,wallet_revision INTEGER,created_at TEXT,document TEXT)',
  'imported_trade_lot_links(owner_id TEXT,id TEXT,project_id TEXT,buy_receipt_id TEXT,sell_receipt_id TEXT,units_raw TEXT,buy_signature TEXT,sell_signature TEXT,buy_preparation_sha256 TEXT,sell_preparation_sha256 TEXT,created_at TEXT)',
  'wallet_warmup_plans(owner_id TEXT,id TEXT,document TEXT,archived INTEGER)',
  'warmup_buy_receipts(owner_id TEXT,id TEXT,plan_id TEXT,signature TEXT,document TEXT,plan_revision INTEGER,wallet_revision INTEGER,cycle INTEGER,wallet_address TEXT,remaining_raw TEXT)',
  'warmup_sell_receipts(owner_id TEXT,id TEXT,plan_id TEXT,signature TEXT,document TEXT,buy_receipt_id TEXT,consumed_raw TEXT)',
  'jito_bundles(owner_id TEXT,id TEXT,document TEXT,state TEXT)',
  'jito_bundle_packets(owner_id TEXT,bundle_id TEXT,packet INTEGER,signature TEXT)',
  'jito_bundle_finalizations(owner_id TEXT,bundle_id TEXT,document TEXT)',
];
let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'account-performance-tests',
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
          env: { DB: { type: 'd1', id: 'account-performance-test-only' } },
        },
      },
    ],
  });
  mocks.db = await mf.getD1Database('DB', 'account-performance-tests');
  for (const table of tables)
    await mocks.db.prepare(`CREATE TABLE ${table}`).run();
});
afterAll(async () => mf?.dispose());
beforeEach(async () => {
  mocks.user = { userId: 'one' };
  for (const table of tables)
    await mocks.db.prepare(`DELETE FROM ${table.split('(')[0]}`).run();
});
async function importedFixture(owner = 'one') {
  await mocks.db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,1)')
    .bind(
      owner,
      id(1),
      JSON.stringify({
        token: {
          chain: 'Solana',
          address: mint,
          decimals: 0,
          name: 'Imported basket',
        },
      }),
    )
    .run();
  const receipts = [
    acquisitionReceipt(2, 'Buy', '2'),
    acquisitionReceipt(3, 'Buy', '1'),
    acquisitionReceipt(4, 'Sell', '3'),
  ];
  for (const r of receipts)
    await mocks.db
      .prepare('INSERT INTO imported_swap_receipts VALUES(?,?,?,?,?,?,?,?)')
      .bind(
        owner,
        r.projectId,
        r.id,
        r.preparationId,
        r.projectRevision,
        r.walletRevision,
        r.createdAt,
        JSON.stringify(r.document),
      )
      .run();
  for (const [i, b] of receipts.slice(0, 2).entries())
    await mocks.db
      .prepare(
        'INSERT INTO imported_trade_lot_links VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        owner,
        id(500 + i),
        id(1),
        b.id,
        receipts[2].id,
        b.document.tokenUnitsRaw,
        b.document.signature,
        receipts[2].document.signature,
        b.document.preparationSha256,
        receipts[2].document.preparationSha256,
        date,
      )
      .run();
}
async function warmupFixture() {
  await mocks.db
    .prepare('INSERT INTO wallet_warmup_plans VALUES(?,?,?,1)')
    .bind('one', id(10), JSON.stringify({ name: 'Recorded warmup' }))
    .run();
  const doc = {
    network: 'mainnet',
    commitment: 'finalized',
    signatureVerified: true,
    signature: signature(110),
    wallet,
    mint,
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
      id(10),
      doc.signature,
      JSON.stringify(doc),
      1,
      1,
      1,
      wallet,
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
      id(10),
      sold.signature,
      JSON.stringify(sold),
      id(110),
      '1',
    )
    .run();
}
it('authenticates and returns an explicit empty summary without invented gains', async () => {
  mocks.user = null;
  expect((await GET(new Request('http://localhost:3000/api/account-performance'))).status).toBe(401);
  mocks.user = { userId: 'empty' };
  expect(await (await GET(new Request('http://localhost:3000/api/account-performance'))).json()).toMatchObject({
    receiptCount: 0,
    recordedRealizedLamports: null,
    scopes: [],
  });
});
it('reads owner-bound bundle expenses in the real D1 snapshot and reconciles partial exits, timeline and CSV', async () => {
  const { f, row, receipts, proof } = await jitoPerformanceFixture();
  const buy = receipts[0];
  const sell = acquisitionReceipt(
    240,
    'Sell',
    '1',
    buy.document.wallet,
    proof.slot + 1,
  );
  sell.projectId = buy.projectId;
  sell.document.mint = buy.document.mint;
  const link = proposedImportedLotLink(
    [...receipts, sell],
    [],
    buy.projectId,
    buy.id,
    sell.id,
    id(900),
    date,
  );
  await mocks.db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,0)')
    .bind(
      'one',
      buy.projectId,
      JSON.stringify({
        token: {
          chain: 'Solana',
          address: buy.document.mint,
          decimals: 0,
          name: 'Bundle cost test',
        },
      }),
    )
    .run();
  for (const receipt of [...receipts, sell])
    await mocks.db
      .prepare('INSERT INTO imported_swap_receipts VALUES(?,?,?,?,?,?,?,?)')
      .bind(
        'one',
        receipt.projectId,
        receipt.id,
        receipt.preparationId,
        receipt.projectRevision,
        receipt.walletRevision,
        receipt.createdAt,
        JSON.stringify(receipt.document),
      )
      .run();
  await mocks.db
    .prepare(
      'INSERT INTO imported_trade_lot_links VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    )
    .bind(
      'one',
      link.id,
      link.projectId,
      link.buyReceiptId,
      link.sellReceiptId,
      link.unitsRaw,
      link.buySignature,
      link.sellSignature,
      link.buyPreparationSha256,
      link.sellPreparationSha256,
      link.createdAt,
    )
    .run();
  for (const owner of ['one', 'foreign']) {
    await mocks.db
      .prepare('INSERT INTO jito_bundles VALUES(?,?,?,?)')
      .bind(owner, row.id, row.document, row.state)
      .run();
    await mocks.db
      .prepare('INSERT INTO jito_bundle_finalizations VALUES(?,?,?)')
      .bind(owner, row.id, owner === 'one' ? row.finalizationDocument : '{}')
      .run();
    for (const p of JSON.parse(row.packets))
      await mocks.db
        .prepare('INSERT INTO jito_bundle_packets VALUES(?,?,?,?)')
        .bind(owner, row.id, p.packet, p.signature)
        .run();
  }
  const response = await GET(new Request('http://localhost:3000/api/account-performance'));
  expect(response.status).toBe(200);
  const summary = (await response.json()) as AccountPerformance;
  const expense = (BigInt(f.manifest.tip.amountRaw) + 2n) / 2n;
  const cost = (101n + expense) / 3n;
  expect(summary).toMatchObject({
    bundleTipLamports: f.manifest.tip.amountRaw,
    bundleFeeLamports: '1',
    missingBundleCostCount: 0,
    allocatedCostLamports: cost.toString(),
    recordedRealizedLamports: (49n - cost).toString(),
  });
  const view = (await (
    await GET(
      new Request('https://bundle.test/api/account-performance?view=timeline'),
    )
  ).json()) as {
    summary: AccountPerformance;
    timeline: PerformanceTimelineData;
  };
  expect(
    validatedTimelineData(view.timeline, view.summary).sales[0].resultLamports,
  ).toBe(summary.recordedRealizedLamports);
  const csv = await (
    await GET(
      new Request('https://bundle.test/api/account-performance?format=csv'),
    )
  ).text();
  expect(csv).toContain(
    'bundleTipLamports,bundleFeeLamports,missingBundleCostCount',
  );
  await mocks.db
    .prepare('DELETE FROM jito_bundle_finalizations WHERE owner_id=?')
    .bind('one')
    .run();
  const missing = (await (await GET(new Request('http://localhost:3000/api/account-performance'))).json()) as AccountPerformance;
  expect(missing).toMatchObject({
    missingBundleCostCount: 1,
    recordedRealizedLamports: null,
  });
  // The foreign receipt cannot satisfy the missing owner receipt or supply its costs.
  expect(missing.bundleTipLamports).toBe('0');
  await mocks.db.prepare('DROP TABLE jito_bundle_packets').run();
  try {
    const legacyResponse = await GET(new Request('http://localhost:3000/api/account-performance'));
    expect(legacyResponse.status).toBe(200);
    const legacy = (await legacyResponse.json()) as AccountPerformance;
    expect(legacy).toMatchObject({
      bundleCostStorageUnavailable: true,
      recordedRealizedLamports: null,
    });
    expect(accountPerformanceCsv(legacy)).toContain(
      'bundleCostStorageUnavailable',
    );
  } finally {
    await mocks.db
      .prepare(
        'CREATE TABLE jito_bundle_packets(owner_id TEXT,bundle_id TEXT,packet INTEGER,signature TEXT)',
      )
      .run();
  }
});
it('aggregates two-source sales and partial warmup exits exactly across archived scopes with owner isolation', async () => {
  await importedFixture();
  await importedFixture('other');
  await warmupFixture();
  const response = await GET(new Request('http://localhost:3000/api/account-performance'));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const value = (await response.json()) as AccountPerformance;
  expect(value).toMatchObject({
    receiptCount: 5,
    buyCount: 3,
    sellCount: 2,
    linkedSaleCount: 2,
    unlinkedSaleCount: 0,
    allocatedCostLamports: '237',
    unallocatedCostLamports: '70',
    linkedNetProceedsLamports: '92',
    linkedResultLamports: '-145',
    recordedRealizedLamports: '-145',
    successfulFeeLamports: '15',
    rentChangeLamports: '40',
  });
  expect(value.scopes).toHaveLength(2);
  expect(value.scopes.every((s) => s.archived)).toBe(true);
  mkdirSync('work/account-performance-qa', { recursive: true });
  writeFileSync(
    'work/account-performance-qa/fixture.json',
    JSON.stringify(value, null, 2),
  );
});
it('withholds complete results for unlinked inventory sales rather than treating their proceeds as profit', async () => {
  await importedFixture();
  const r = acquisitionReceipt(5, 'Sell', '1');
  await mocks.db
    .prepare('INSERT INTO imported_swap_receipts VALUES(?,?,?,?,?,?,?,?)')
    .bind(
      'one',
      r.projectId,
      r.id,
      r.preparationId,
      r.projectRevision,
      r.walletRevision,
      r.createdAt,
      JSON.stringify(r.document),
    )
    .run();
  expect(await (await GET(new Request('http://localhost:3000/api/account-performance'))).json()).toMatchObject({
    recordedRealizedLamports: null,
    linkedResultLamports: '-153',
    unlinkedSaleCount: 1,
  });
});
it('refuses incomplete splits, orphan projects and cross-plan warmup sales without partial totals', async () => {
  await importedFixture();
  await warmupFixture();
  await mocks.db
    .prepare('DELETE FROM imported_trade_lot_links WHERE owner_id=? AND id=?')
    .bind('one', id(501))
    .run();
  expect((await GET(new Request('http://localhost:3000/api/account-performance'))).status).toBe(503);
  await mocks.db.prepare('DELETE FROM imported_trade_lot_links').run();
  await mocks.db.prepare('DELETE FROM imported_token_projects').run();
  expect((await GET(new Request('http://localhost:3000/api/account-performance'))).status).toBe(503);
  await mocks.db.prepare('DELETE FROM imported_swap_receipts').run();
  await mocks.db
    .prepare('INSERT INTO wallet_warmup_plans VALUES(?,?,?,0)')
    .bind('one', id(11), JSON.stringify({ name: 'Other plan' }))
    .run();
  await mocks.db
    .prepare('UPDATE warmup_sell_receipts SET plan_id=?')
    .bind(id(11))
    .run();
  expect((await GET(new Request('http://localhost:3000/api/account-performance'))).status).toBe(503);
});
it('reads all receipts beyond one UI page and rejects duplicate cross-workflow signatures', async () => {
  await importedFixture();
  await mocks.db.prepare('DELETE FROM imported_trade_lot_links').run();
  await mocks.db.prepare('DELETE FROM imported_swap_receipts').run();
  await mocks.db.batch(
    Array.from({ length: 56 }, (_, i) => {
      const r = acquisitionReceipt(i + 20);
      return mocks.db
        .prepare('INSERT INTO imported_swap_receipts VALUES(?,?,?,?,?,?,?,?)')
        .bind(
          'one',
          r.projectId,
          r.id,
          r.preparationId,
          r.projectRevision,
          r.walletRevision,
          r.createdAt,
          JSON.stringify(r.document),
        );
    }),
  );
  expect(await (await GET(new Request('http://localhost:3000/api/account-performance'))).json()).toMatchObject({
    receiptCount: 56,
    unallocatedCostLamports: '5656',
    recordedRealizedLamports: null,
  });
  await warmupFixture();
  const buy = acquisitionReceipt(110);
  await mocks.db
    .prepare('UPDATE imported_swap_receipts SET document=? WHERE id=?')
    .bind(JSON.stringify(buy.document), id(20))
    .run();
  expect((await GET(new Request('http://localhost:3000/api/account-performance'))).status).toBe(503);
});
it('rejects an over-capacity account snapshot before displaying any subset', async () => {
  await importedFixture();
  await mocks.db.prepare('DELETE FROM imported_trade_lot_links').run();
  await mocks.db
    .prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<4001) INSERT INTO imported_swap_receipts SELECT owner_id,project_id,printf('00000000-0000-4000-8000-%012d',x+1000),preparation_id,project_revision,wallet_revision,created_at,document FROM imported_swap_receipts,n WHERE id=?`,
    )
    .bind(id(2))
    .run();
  const response = await GET(new Request('http://localhost:3000/api/account-performance'));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error:
      'Recorded trading performance unavailable. No partial totals are shown.',
  });
});
const timelineRequest = (query = 'view=timeline') =>
  new Request(`http://localhost/api/account-performance?${query}`);
it('returns per-sale results from the same snapshot that reconcile exactly with the summary', async () => {
  await importedFixture();
  await importedFixture('other');
  await warmupFixture();
  await mocks.db
    .prepare(
      "UPDATE warmup_sell_receipts SET document=json_set(document,'$.blockTime',1791000000)",
    )
    .run();
  const response = await GET(timelineRequest());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = (await response.json()) as {
    summary: AccountPerformance;
    timeline: PerformanceTimelineData;
  };
  const timeline = validatedTimelineData(body.timeline, body.summary);
  expect(body.summary.linkedResultLamports).toBe('-145');
  expect(
    timeline.sales
      .map((s) => [s.kind, s.costLamports, s.resultLamports, s.blockTime])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ).toEqual([
    ['Imported trades', '202', '-153', null],
    ['Warmup', '35', '8', 1791000000],
  ]);
  expect(timeline.unlinkedSaleCount).toBe(0);
});
it('splits one lot across sequential sales exactly, matching the aggregate allocation', async () => {
  await warmupFixture();
  // Buy cost is 105 for 3 units; two 1-unit sales take 35 then 35 (floor(105*2/3) - 35).
  await mocks.db
    .prepare("UPDATE warmup_buy_receipts SET remaining_raw='1'")
    .run();
  const first = JSON.parse(
    (await mocks.db
      .prepare('SELECT document FROM warmup_sell_receipts')
      .first<{ document: string }>())!.document,
  );
  const second = {
    ...first,
    signature: signature(112),
    slot: 102,
    nativeSettlementRaw: '20',
    networkFeeLamports: '5',
  };
  await mocks.db
    .prepare('INSERT INTO warmup_sell_receipts VALUES(?,?,?,?,?,?,?)')
    .bind(
      'one',
      id(112),
      id(10),
      second.signature,
      JSON.stringify(second),
      id(110),
      '1',
    )
    .run();
  const body = (await (await GET(timelineRequest())).json()) as {
    summary: AccountPerformance;
    timeline: PerformanceTimelineData;
  };
  const timeline = validatedTimelineData(body.timeline, body.summary);
  const bySlot = [...timeline.sales].sort((a, b) => a.slot - b.slot);
  expect(bySlot.map((s) => [s.costLamports, s.resultLamports])).toEqual([
    ['35', '8'],
    ['35', '-20'],
  ]);
  expect(body.summary.linkedResultLamports).toBe('-12');
});
it('rejects unsupported timeline query combinations and withholds damaged snapshots', async () => {
  for (const query of [
    'view=chart',
    'view=timeline&view=timeline',
    'view=timeline&format=csv',
    'view=timeline&owner=other',
  ])
    expect((await GET(timelineRequest(query))).status).toBe(400);
  mocks.user = null;
  expect((await GET(timelineRequest())).status).toBe(401);
  mocks.user = { userId: 'one' };
  await importedFixture();
  await mocks.db
    .prepare('DELETE FROM imported_trade_lot_links WHERE owner_id=? AND id=?')
    .bind('one', id(501))
    .run();
  expect((await GET(timelineRequest())).status).toBe(503);
});
it('exports a fresh complete owned snapshot as a downloadable CSV and rejects unsupported query contexts', async () => {
  const request = () =>
    new Request('http://localhost/api/account-performance?format=csv');
  mocks.user = null;
  expect((await GET(request())).status).toBe(401);
  mocks.user = { userId: 'one' };
  await importedFixture();
  await importedFixture('other');
  await warmupFixture();
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/csv;charset=utf-8');
  expect(response.headers.get('content-disposition')).toContain(
    'attachment; filename="bundle-recorded-performance.csv"',
  );
  expect(response.headers.get('cache-control')).toBe('no-store');
  const csv = await response.text();
  mkdirSync('work/account-performance-qa', { recursive: true });
  writeFileSync('work/account-performance-qa/fixture.csv', csv);
  expect(csv.trim().split('\r\n')).toHaveLength(3);
  expect(csv).toContain('"202","0","49","\'-153","3","0"');
  expect(csv).toContain('"35","70","43","8","12","40"');
  expect(
    (
      await GET(
        new Request('http://localhost/api/account-performance?format=json'),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await GET(
        new Request(
          'http://localhost/api/account-performance?format=csv&owner=other',
        ),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await GET(
        new Request(
          'http://localhost/api/account-performance?format=csv&format=csv',
        ),
      )
    ).status,
  ).toBe(400);
  await mocks.db
    .prepare('DELETE FROM imported_trade_lot_links WHERE owner_id=? AND id=?')
    .bind('one', id(501))
    .run();
  const damaged = await GET(request());
  expect(damaged.status).toBe(503);
  expect(damaged.headers.get('content-type')).toContain('application/json');
  expect(damaged.headers.get('content-disposition')).toBeNull();
});
