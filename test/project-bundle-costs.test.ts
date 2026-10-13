import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { jitoPerformanceFixture } from './jito-performance-fixture';
import {
  acquisitionReceipt,
  acquisitionId,
} from './imported-sell-acquisition-fixture';
import {
  proposedImportedLotLink,
  importedLotPage,
} from '../lib/imported-lot-links';
import { createJitoFinalization } from '../lib/jito-finalization';
import { importedTradePage } from '../lib/imported-trade-ledger';
const state = vi.hoisted(() => ({
  user: { userId: 'one' } as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => state.user,
}));
vi.mock('@/db', () => ({ getD1: () => state.db }));
import { GET as receiptsGet } from '../app/api/imported-projects/receipts/route';
import { GET as lotsGet } from '../app/api/imported-projects/lot-links/route';
let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'project-bundle-costs',
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
          env: { DB: { type: 'd1', id: 'project-bundle-cost-only' } },
        },
      },
    ],
  });
  state.db = await mf.getD1Database('DB', 'project-bundle-costs');
  for (const table of [
    'imported_token_projects(owner_id TEXT,id TEXT,document TEXT,archived INTEGER)',
    'imported_swap_receipts(owner_id TEXT,project_id TEXT,id TEXT,preparation_id TEXT,project_revision INTEGER,wallet_revision INTEGER,created_at TEXT,document TEXT)',
    'imported_trade_lot_links(owner_id TEXT,id TEXT,project_id TEXT,buy_receipt_id TEXT,sell_receipt_id TEXT,units_raw TEXT,buy_signature TEXT,sell_signature TEXT,buy_preparation_sha256 TEXT,sell_preparation_sha256 TEXT,created_at TEXT)',
    'imported_trade_lot_gates(owner_id TEXT,project_id TEXT,revision INTEGER)',
    'jito_bundles(owner_id TEXT,id TEXT,document TEXT,state TEXT)',
    'jito_bundle_packets(owner_id TEXT,bundle_id TEXT,packet INTEGER,signature TEXT)',
    'jito_bundle_finalizations(owner_id TEXT,bundle_id TEXT,document TEXT)',
  ])
    await state.db.prepare(`CREATE TABLE ${table}`).run();
});
afterAll(async () => mf?.dispose());
it('uses one owner/project snapshot for expense-aware FIFO, linked acquisition and exports', async () => {
  const { f, row, receipts, proof } = await jitoPerformanceFixture();
  const buy = receipts[0];
  const sell = acquisitionReceipt(
    245,
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
    acquisitionId(901),
    new Date().toISOString(),
  );
  await state.db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,1)')
    .bind(
      'one',
      buy.projectId,
      JSON.stringify({
        token: { chain: 'Solana', address: buy.document.mint, decimals: 0 },
      }),
    )
    .run();
  for (const r of [...receipts, sell])
    await state.db
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
  await state.db
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
    await state.db
      .prepare('INSERT INTO jito_bundles VALUES(?,?,?,?)')
      .bind(owner, row.id, row.document, row.state)
      .run();
    await state.db
      .prepare('INSERT INTO jito_bundle_finalizations VALUES(?,?,?)')
      .bind(owner, row.id, owner === 'one' ? row.finalizationDocument : '{}')
      .run();
    for (const p of JSON.parse(row.packets))
      await state.db
        .prepare('INSERT INTO jito_bundle_packets VALUES(?,?,?,?)')
        .bind(owner, row.id, p.packet, p.signature)
        .run();
  }
  const request = new Request(
    `https://bundle.test/api/imported-projects/receipts?projectId=${buy.projectId}`,
  );
  const response = await receiptsGet(request);
  expect(response.status).toBe(200);
  const ledger = importedTradePage(
    await response.json(),
    buy.projectId,
    buy.document.mint,
    0,
  );
  const share = (BigInt(f.manifest.tip.amountRaw) + 2n) / 2n,
    cost = (101n + share) / 3n;
  expect(ledger.performance.realizedResultLamports).toBe(
    (49n - cost).toString(),
  );
  expect(ledger.performance.bundleTipLamports).toBe(f.manifest.tip.amountRaw);
  const lotResponse = await lotsGet(request);
  expect(lotResponse.status).toBe(200);
  const lots = importedLotPage(
    await lotResponse.json(),
    buy.projectId,
    buy.document.mint,
    0,
  );
  expect(lots.performance.realizedResultLamports).toBe(
    ledger.performance.realizedResultLamports,
  );
  expect(lots.performance.assignedCostLamports).toBe(cost.toString());
  const csv = await (
    await receiptsGet(new Request(request.url + '&format=csv'))
  ).text();
  expect(csv).toContain('allocated_bundle_cost_lamports');
  expect(csv).toContain('bundle_cost_coverage');
  const legacy = await createJitoFinalization(
    f.manifest,
    proof.signatures,
    proof.slot,
  );
  await state.db
    .prepare('UPDATE jito_bundle_finalizations SET document=? WHERE owner_id=?')
    .bind(JSON.stringify(legacy), 'one')
    .run();
  const missingLedger = importedTradePage(
    await (await receiptsGet(request)).json(),
    buy.projectId,
    buy.document.mint,
    0,
  );
  expect(missingLedger.performance).toMatchObject({
    missingBundleCostCount: 1,
    realizedResultLamports: null,
  });
  const missingLots = importedLotPage(
    await (await lotsGet(request)).json(),
    buy.projectId,
    buy.document.mint,
    0,
  );
  expect(missingLots.performance.realizedResultLamports).toBeNull();
  expect(missingLots.expenses.missingBundleCostCount).toBe(1);
  expect(
    await (await receiptsGet(new Request(request.url + '&format=csv'))).text(),
  ).toContain('incomplete');
  state.user = { userId: 'foreign' };
  expect((await receiptsGet(request)).status).toBe(404);
  expect((await lotsGet(request)).status).toBe(404);
  state.user = { userId: 'one' };
  await state.db.prepare('DROP TABLE jito_bundle_finalizations').run();
  const legacyResponse = await receiptsGet(request);
  expect(legacyResponse.status).toBe(200);
  const legacyLedger = importedTradePage(
    await legacyResponse.json(),
    buy.projectId,
    buy.document.mint,
    0,
  );
  expect(legacyLedger.receipts).toHaveLength(3);
  expect(legacyLedger.performance).toMatchObject({
    bundleCostStorageUnavailable: true,
    realizedResultLamports: null,
    missingBundleCostCount: 0,
  });
  const legacyLots = importedLotPage(
    await (await lotsGet(request)).json(),
    buy.projectId,
    buy.document.mint,
    0,
  );
  expect(legacyLots.expenses.storageUnavailable).toBe(true);
  expect(legacyLots.performance.realizedResultLamports).toBeNull();
  expect(
    await (await receiptsGet(new Request(request.url + '&format=csv'))).text(),
  ).toContain('storage-unavailable');
  // Installed but invalid schemas still fail; this is not an error-swallowing fallback.
  await state.db
    .prepare(
      'CREATE TABLE jito_bundle_finalizations(owner_id TEXT,bundle_id TEXT)',
    )
    .run();
  expect((await receiptsGet(request)).status).toBe(503);
  expect((await lotsGet(request)).status).toBe(503);
});
