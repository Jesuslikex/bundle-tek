import { beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import bs58 from 'bs58';
import type { ImportedLotPage } from '@/lib/imported-lot-links';
const mocks = vi.hoisted(() => ({
  user: { userId: 'one' } as { userId: string } | null,
  db: null as unknown as D1Database,
}));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => mocks.user,
}));
vi.mock('@/db', () => ({ getD1: () => mocks.db }));
import { GET, POST } from './route';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const sig = (n: number) => bs58.encode(new Uint8Array(64).fill(n));
const date = '2026-10-11T00:00:00Z',
  projectId = id(1);
let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'lot-link-tests',
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
          env: { DB: { type: 'd1', id: 'isolated-lot-links-tests' } },
        },
      },
    ],
  });
  mocks.db = await mf.getD1Database('DB', 'lot-link-tests');
  await mocks.db
    .prepare(
      'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,document TEXT,archived INTEGER)',
    )
    .run();
  await mocks.db
    .prepare(
      'CREATE TABLE imported_swap_receipts(owner_id TEXT,project_id TEXT,id TEXT,preparation_id TEXT,project_revision INTEGER,wallet_revision INTEGER,created_at TEXT,document TEXT,intent_id TEXT)',
    )
    .run();
  for (const sql of [
    'CREATE TABLE jito_bundles(owner_id TEXT,id TEXT,document TEXT,state TEXT)',
    'CREATE TABLE jito_bundle_packets(owner_id TEXT,bundle_id TEXT,packet INTEGER,signature TEXT)',
    'CREATE TABLE jito_bundle_finalizations(owner_id TEXT,bundle_id TEXT,document TEXT)',
    'CREATE TABLE solana_swap_reservations(owner_id TEXT,wallet_address TEXT)',
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT)',
    'CREATE TABLE imported_swap_signing_intents(id TEXT,owner_id TEXT,preparation_id TEXT,state TEXT,signature TEXT,wallet_address TEXT,document TEXT)',
    'CREATE TABLE imported_swap_preparations(id TEXT,owner_id TEXT,project_id TEXT,document TEXT)',
    'CREATE TABLE imported_swap_signing_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT,owner_id TEXT,intent_id TEXT,preparation_id TEXT,project_id TEXT,project_revision INTEGER,wallet_revision INTEGER,wallet_address TEXT,type TEXT,state TEXT,signature TEXT,document TEXT,created_at TEXT,failure_receipt TEXT)',
  ])
    await mocks.db.prepare(sql).run();
  for (const statement of readFileSync(
    new URL('../../../../drizzle/0053_imported_lot_links.sql', import.meta.url),
    'utf8',
  ).split('--> statement-breakpoint'))
    if (statement.trim()) await mocks.db.prepare(statement).run();
  for (const statement of readFileSync(
    new URL(
      '../../../../drizzle/0054_imported_approved_acquisition.sql',
      import.meta.url,
    ),
    'utf8',
  ).split('--> statement-breakpoint'))
    if (statement.trim()) await mocks.db.prepare(statement).run();
  await mocks.db
    .prepare(
      'CREATE TRIGGER imported_swap_failure_recovery AFTER UPDATE ON imported_swap_signing_intents BEGIN SELECT 1; END',
    )
    .run();
  for (const statement of readFileSync(
    new URL(
      '../../../../drizzle/0055_imported_acquisition_baskets.sql',
      import.meta.url,
    ),
    'utf8',
  ).split('--> statement-breakpoint'))
    if (statement.trim()) await mocks.db.prepare(statement).run();
});
afterAll(async () => mf?.dispose());
async function trade(
  n: number,
  side: 'Buy' | 'Sell',
  units = '1',
  slot = n,
  wallet = 2,
  owner = 'one',
) {
  const document = {
    network: 'mainnet',
    commitment: 'finalized',
    signatureVerified: true,
    signature: sig(n),
    wallet: key(wallet),
    mint: key(3),
    decimals: 6,
    preparationSha256: 'a'.repeat(64),
    side,
    tokenUnitsRaw: units,
    source: 'provider.test',
    observedAt: date,
    slot,
    blockTime: null,
    networkFeeLamports: '1',
    nativeChangeRaw: side === 'Buy' ? '-101' : '49',
    rentChangeRaw: '0',
    nativeSettlementRaw: side === 'Buy' ? '-100' : '50',
  };
  await mocks.db
    .prepare(
      'INSERT INTO imported_swap_receipts(owner_id,project_id,id,preparation_id,project_revision,wallet_revision,created_at,document) VALUES(?,?,?,?,?,?,?,?)',
    )
    .bind(
      owner,
      projectId,
      id(n),
      id(n + 100),
      1,
      1,
      date,
      JSON.stringify(document),
    )
    .run();
}
beforeEach(async () => {
  mocks.user = { userId: 'one' };
  await mocks.db
    .prepare('DROP TRIGGER imported_trade_lot_links_immutable_delete')
    .run();
  await mocks.db.prepare('DELETE FROM imported_trade_lot_links').run();
  await mocks.db
    .prepare(
      "CREATE TRIGGER imported_trade_lot_links_immutable_delete BEFORE DELETE ON imported_trade_lot_links BEGIN SELECT RAISE(ABORT,'Acquisition link is immutable'); END",
    )
    .run();
  for (const table of [
    'jito_bundles',
    'jito_bundle_packets',
    'jito_bundle_finalizations',
    'solana_execution_reservations',
    'imported_trade_lot_gates',
    'imported_swap_receipts',
    'imported_token_projects',
  ])
    await mocks.db.prepare(`DELETE FROM ${table}`).run();
  await mocks.db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,1)')
    .bind(
      'one',
      projectId,
      JSON.stringify({
        token: { chain: 'Solana', address: key(3), decimals: 6 },
      }),
    )
    .run();
  await trade(2, 'Buy', '3', 2);
  await trade(3, 'Sell', '1', 3);
  await trade(4, 'Sell', '2', 4);
});
const read = () =>
  GET(
    new Request(
      `http://localhost/api/imported-projects/lot-links?projectId=${projectId}`,
    ),
  );
const assign = async (
  buy = 2,
  sell = 3,
  revision = 0,
  origin = 'http://localhost',
) => {
  const reviewed = (await (await read()).json()) as ImportedLotPage;
  return POST(
    new Request('http://localhost/api/imported-projects/lot-links', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        projectId,
        buyReceiptId: id(buy),
        sellReceiptId: id(sell),
        revision,
        buyDocumentSha256:
          reviewed.receiptDocumentHashes?.[id(buy)] ?? 'a'.repeat(64),
        sellDocumentSha256:
          reviewed.receiptDocumentHashes?.[id(sell)] ?? 'a'.repeat(64),
      }),
    }),
  );
};
it('isolates owners, rejects cross-origin requests and keeps archived accounting readable', async () => {
  mocks.user = null;
  expect((await read()).status).toBe(401);
  expect((await assign()).status).toBe(401);
  mocks.user = { userId: 'other' };
  expect((await read()).status).toBe(404);
  expect((await assign()).status).toBe(404);
  mocks.user = { userId: 'one' };
  expect((await assign(2, 3, 0, 'https://unrelated.test')).status).toBe(400);
  const r = await read();
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(await r.json()).toMatchObject({
    revision: 0,
    performance: {
      linkedSaleCount: 0,
      unlinkedSaleCount: 2,
      realizedResultLamports: null,
    },
  });
});
it('records exact partial and complete basis, retains idempotent retries, and freezes source evidence', async () => {
  let r = await assign();
  expect(r.status).toBe(200);
  let body = (await r.json()) as ImportedLotPage;
  expect(body).toMatchObject({
    revision: 1,
    performance: {
      linkedSaleCount: 1,
      unlinkedSaleCount: 1,
      assignedCostLamports: '33',
      netAssignedProceedsLamports: '49',
      assignedResultLamports: '16',
      realizedResultLamports: null,
    },
  });
  expect(body.performance.lots[0]).toMatchObject({
    unassignedRaw: '2',
    unassignedCostLamports: '68',
  });
  mkdirSync('work/imported-lot-links-qa', { recursive: true });
  writeFileSync(
    'work/imported-lot-links-qa/partial.json',
    JSON.stringify(body, null, 2),
  );
  expect((await assign()).status).toBe(200);
  expect((await assign(2, 4, 0)).status).toBe(409);
  for (const sql of [
    "UPDATE imported_trade_lot_links SET units_raw='2'",
    'DELETE FROM imported_trade_lot_links',
    "UPDATE imported_swap_receipts SET document=json_set(document,'$.networkFeeLamports','2') WHERE id=?",
    'DELETE FROM imported_swap_receipts WHERE id=?',
  ])
    await expect(
      mocks.db
        .prepare(sql)
        .bind(...(sql.includes('?') ? [id(2)] : []))
        .run(),
    ).rejects.toThrow();
  r = await assign(2, 4, 1);
  expect(r.status).toBe(200);
  body = (await r.json()) as ImportedLotPage;
  expect(body.performance).toMatchObject({
    linkedSaleCount: 2,
    unlinkedSaleCount: 0,
    assignedCostLamports: '101',
    netAssignedProceedsLamports: '98',
    assignedResultLamports: '-3',
    realizedResultLamports: '-3',
  });
  expect(body.performance.lots[0]).toMatchObject({
    unassignedRaw: '0',
    unassignedCostLamports: '0',
  });
  mkdirSync('work/imported-lot-links-qa', { recursive: true });
  writeFileSync(
    'work/imported-lot-links-qa/linked.json',
    JSON.stringify(body, null, 2),
  );
});
it('serializes concurrent assignments without overallocating a buy', async () => {
  await mocks.db
    .prepare(
      "UPDATE imported_swap_receipts SET document=json_set(document,'$.tokenUnitsRaw','2') WHERE id=?",
    )
    .bind(id(3))
    .run();
  const result = await Promise.all([assign(2, 3), assign(2, 4)]);
  expect(result.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
  const body = (await (await read()).json()) as ImportedLotPage;
  expect(body.revision).toBe(1);
  expect(body.links).toHaveLength(1);
  expect(body.performance.lots[0].unassignedRaw).toBe('1');
  expect(
    (await assign(2, body.links[0].sellReceiptId === id(3) ? 4 : 3, 1)).status,
  ).toBe(422);
});
it('requires a fresh review when unlinked receipt economics change without a link revision change', async () => {
  const page = (await (await read()).json()) as ImportedLotPage;
  await mocks.db
    .prepare(
      "UPDATE imported_swap_receipts SET document=json_set(document,'$.networkFeeLamports','2','$.nativeChangeRaw','-102') WHERE id=?",
    )
    .bind(id(2))
    .run();
  const r = await POST(
    new Request('http://localhost/api/imported-projects/lot-links', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify({
        projectId,
        revision: page.revision,
        buyReceiptId: id(2),
        sellReceiptId: id(3),
        buyDocumentSha256: page.receiptDocumentHashes[id(2)],
        sellDocumentSha256: page.receiptDocumentHashes[id(3)],
      }),
    }),
  );
  expect(r.status).toBe(409);
  expect(await r.json()).toMatchObject({
    error: 'Reviewed receipt evidence changed. Reload and review again.',
  });
  expect(
    await mocks.db
      .prepare('SELECT COUNT(*) AS count FROM imported_trade_lot_links')
      .first(),
  ).toMatchObject({ count: 0 });
  expect((await assign()).status).toBe(200);
});
it('rejects wrong wallet, future or same-slot acquisitions and whole-sale overallocation', async () => {
  await trade(5, 'Buy', '100', 5, 9);
  expect((await assign(5, 3)).status).toBe(422);
  await trade(6, 'Buy', '100', 3);
  expect((await assign(6, 3)).status).toBe(422);
  await trade(7, 'Buy', '100', 100);
  expect((await assign(7, 3)).status).toBe(422);
  await trade(8, 'Sell', '4', 100);
  expect((await assign(2, 8)).status).toBe(422);
  expect((await assign(3, 2)).status).toBe(422);
});
it('rolls the gate and link back together on an insertion failure', async () => {
  await mocks.db
    .prepare(
      "CREATE TRIGGER qa_fail BEFORE INSERT ON imported_trade_lot_links BEGIN SELECT RAISE(ABORT,'forced test failure'); END",
    )
    .run();
  expect((await assign()).status).toBe(503);
  expect(
    await mocks.db
      .prepare('SELECT COUNT(*) AS count FROM imported_trade_lot_gates')
      .first(),
  ).toMatchObject({ count: 0 });
  await mocks.db.prepare('DROP TRIGGER qa_fail').run();
  expect((await assign()).status).toBe(200);
});
it('uses all retained receipts beyond 50 rows and withholds oversized histories', async () => {
  await mocks.db.prepare('DELETE FROM imported_swap_receipts').run();
  await trade(2, 'Buy', '60', 1);
  for (let n = 3; n < 58; n++) await trade(n, 'Sell', '1', n);
  let body = (await (await read()).json()) as ImportedLotPage;
  expect(body.receipts).toHaveLength(56);
  mkdirSync('work/imported-lot-links-qa', { recursive: true });
  writeFileSync(
    'work/imported-lot-links-qa/paged.json',
    JSON.stringify(body, null, 2),
  );
  expect((await assign(2, 57)).status).toBe(200);
  body = (await (await read()).json()) as ImportedLotPage;
  expect(body.performance.unlinkedSaleCount).toBe(54);
  await mocks.db
    .prepare('DROP TRIGGER imported_trade_lot_links_immutable_delete')
    .run();
  await mocks.db.prepare('DELETE FROM imported_trade_lot_links').run();
  await mocks.db
    .prepare(
      "CREATE TRIGGER imported_trade_lot_links_immutable_delete BEFORE DELETE ON imported_trade_lot_links BEGIN SELECT RAISE(ABORT,'Acquisition link is immutable'); END",
    )
    .run();
  for (let n = 0; n < 7; n++)
    await mocks.db
      .prepare(
        'INSERT INTO imported_swap_receipts SELECT * FROM imported_swap_receipts',
      )
      .run();
  expect((await read()).status).toBe(503);
  expect((await assign()).status).toBe(503);
});

it('blocks acquisition assignment during any reserved wallet execution, including withdrawals', async () => {
  await mocks.db
    .prepare('INSERT INTO solana_execution_reservations VALUES(?,?)')
    .bind('one', key(2))
    .run();
  expect((await assign()).status).toBe(409);
  expect(
    await mocks.db
      .prepare('SELECT COUNT(*) AS n FROM imported_trade_lot_links')
      .first(),
  ).toEqual({ n: 0 });
});
