import { afterEach, beforeAll, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { importedSaleEvidenceFixture } from '../test/imported-sale-evidence-fixture';
import {
  planLaunchSaleAllocation,
  type LaunchSaleInput,
} from './launch-sale-allocation';
import type { PumpPurchaseCostSource } from './pump-purchase-costs';
const signal = () => new AbortController().signal;
let sale: Awaited<ReturnType<typeof importedSaleEvidenceFixture>>;
beforeAll(async () => {
  sale = await importedSaleEvidenceFixture();
});
// Controlled arithmetic/SQL parent inputs. Full original proofs are exercised
// separately in the service integration test; these are not chain observations.
function input(beforeRaw = '0', unitsRaw = '1000'): LaunchSaleInput {
  const source = {
    originId: 'a'.repeat(64),
    sha256: 'b'.repeat(64),
    wallet: sale.p.wallet,
    mint: sale.report.mint,
    acquiredRaw: '2000',
    acquisitionBasisVerified: false,
    executionAllowed: false,
  } as PumpPurchaseCostSource;
  return {
    source,
    receiptSha256: 'c'.repeat(64),
    buySlot: '200',
    beforeRaw,
    unitsRaw,
  };
}
async function evidence() {
  const { collectImportedSaleEvidence } =
    await import('./imported-sale-evidence');
  return collectImportedSaleEvidence(sale.p, signal(), sale.rpc);
}
it('plans exact remaining units without claiming basis, expenses or profit', async () => {
  const p = await planLaunchSaleAllocation(
    await evidence(),
    [input('1000')],
    signal(),
  );
  expect(p.allocations[0]).toMatchObject({
    beforeRaw: '1000',
    unitsRaw: '1000',
    afterRaw: '2000',
  });
  expect(p).toMatchObject({
    executionAllowed: false,
    signingAllowed: false,
    profitCalculated: false,
    acquisitionBasisVerified: false,
  });
  expect(p).not.toHaveProperty('profitLamports');
});
it.each([
  'over',
  'incomplete',
  'duplicate',
  'wallet',
  'mint',
  'slot',
  'decimal',
  'zero',
  'noncanonical',
])('refuses invalid selection %s', async (change) => {
  const i = input(),
    e = await evidence();
  let inputs = [i];
  if (change === 'over') i.beforeRaw = '1001';
  if (change === 'incomplete') i.unitsRaw = '999';
  if (change === 'duplicate') inputs = [i, structuredClone(i)];
  if (change === 'wallet') i.source.wallet = '11111111111111111111111111111111';
  if (change === 'mint') i.source.mint = '11111111111111111111111111111111';
  if (change === 'slot') i.buySlot = String(e.report.slot);
  if (change === 'decimal') e.report.decimals = 9;
  if (change === 'zero') i.unitsRaw = '0';
  if (change === 'noncanonical') i.beforeRaw = '00';
  await expect(planLaunchSaleAllocation(e, inputs, signal())).rejects.toThrow();
});
it('handles u64 intervals and canonical basket order without Number rounding', async () => {
  const i = input('18446744073709550615');
  i.source.acquiredRaw = '18446744073709551615';
  const p = await planLaunchSaleAllocation(await evidence(), [i], signal());
  expect(p.allocations[0].afterRaw).toBe('18446744073709551615');
  const a = input('0', '333'),
    b = input('0', '667');
  b.source.originId = 'd'.repeat(64);
  const e = await evidence();
  expect(await planLaunchSaleAllocation(e, [a, b], signal())).toEqual(
    await planLaunchSaleAllocation(e, [b, a], signal()),
  );
});
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
async function sqlFixture() {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  db.exec(`CREATE TABLE imported_sale_receipt_evidence(owner_id TEXT,receipt_id TEXT,signature TEXT,sha256 TEXT,evidence TEXT,parent TEXT,PRIMARY KEY(owner_id,receipt_id));
 CREATE TABLE imported_trade_lot_links(owner_id TEXT,sell_receipt_id TEXT,sell_signature TEXT);
 CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT);
 CREATE TABLE solana_swap_reservations(owner_id TEXT,wallet_address TEXT);
 CREATE TABLE pump_purchase_cost_sources(owner_id TEXT,origin_id TEXT,receipt_id TEXT,review_id TEXT,sha256 TEXT,wallet TEXT,mint TEXT,source TEXT);
 CREATE TABLE pump_purchase_cost_batches(owner_id TEXT,receipt_id TEXT,parent TEXT);
 CREATE TABLE pump_group_receipt_evidence(owner_id TEXT,id TEXT,sha256 TEXT,evidence TEXT);
 CREATE TABLE pump_launch_reviews(owner_id TEXT,id TEXT,review TEXT,signed TEXT,signature TEXT,state TEXT,receipt TEXT);`);
  db.exec(readFileSync('drizzle/0116_launch_sale_allocations.sql', 'utf8'));
  const e = await evidence(),
    i = input(),
    p = await planLaunchSaleAllocation(e, [i], signal());
  const seedSale = (doc: typeof p) =>
    db
      .prepare('INSERT INTO imported_sale_receipt_evidence VALUES(?,?,?,?,?,?)')
      .run(
        'alice',
        doc.saleReceiptId,
        doc.saleSignature,
        doc.saleEvidenceSha256,
        JSON.stringify({
          report: {
            wallet: doc.wallet,
            mint: doc.mint,
            decimals: 6,
            slot: doc.saleSlot,
            acquiredRaw: doc.soldRaw,
          },
        }),
        JSON.stringify({ approvalDocument: '{}' }),
      );
  seedSale(p);
  const parent = {
    review: 'review',
    signed: 'signed',
    signature: 'signature',
    state: 'closed',
    receipt: 'receipt',
  };
  db.prepare('INSERT INTO pump_launch_reviews VALUES(?,?,?,?,?,?,?)').run(
    'alice',
    'launch',
    ...Object.values(parent),
  );
  db.prepare('INSERT INTO pump_purchase_cost_batches VALUES(?,?,?)').run(
    'alice',
    'receipt',
    JSON.stringify(parent),
  );
  db.prepare('INSERT INTO pump_group_receipt_evidence VALUES(?,?,?,?)').run(
    'alice',
    'receipt',
    i.receiptSha256,
    JSON.stringify({
      report: { packets: [{ slot: '200', outcome: 'success' }] },
    }),
  );
  db.prepare(
    'INSERT INTO pump_purchase_cost_sources VALUES(?,?,?,?,?,?,?,?)',
  ).run(
    'alice',
    i.source.originId,
    'receipt',
    'launch',
    i.source.sha256,
    p.wallet,
    p.mint,
    JSON.stringify({ ...i.source, packetIndex: 0 }),
  );
  const insert = (doc: typeof p, owner = 'alice') =>
    db
      .prepare('INSERT INTO launch_sale_allocations VALUES(?,?,?,?,?,?,?,?)')
      .run(
        owner,
        doc.saleReceiptId,
        doc.saleSignature,
        doc.wallet,
        doc.mint,
        JSON.stringify(doc),
        doc.sha256,
        new Date().toISOString(),
      );
  return { db, e, i, p, insert, seedSale };
}
it('atomically consumes global origin intervals across different sale/workspace identities', async () => {
  const f = await sqlFixture();
  f.insert(f.p);
  const e = {
    ...f.e,
    receiptId: crypto.randomUUID(),
    report: { ...f.e.report, signature: 'another-sale' },
  };
  const next = await planLaunchSaleAllocation(
    e,
    [{ ...f.i, beforeRaw: '1000' }],
    signal(),
  );
  f.seedSale(next);
  f.insert(next);
  expect(
    f.db.prepare('SELECT count(*) AS n FROM launch_sale_allocations').get()!.n,
  ).toBe(2);
  const stale = {
    ...next,
    saleReceiptId: crypto.randomUUID(),
    saleSignature: 'stale-sale',
    allocations: f.p.allocations,
  };
  f.seedSale(stale);
  expect(() => f.insert(stale)).toThrow('consumed units');
});
it.each([
  'owner',
  'source',
  'receipt',
  'parent',
  'slot',
  'over',
  'sum',
  'interval',
  'flags',
  'active',
  'legacy',
  'missingUnits',
  'approvedLegacy',
])('SQL refuses changed %s', async (change) => {
  const f = await sqlFixture(),
    p = structuredClone(f.p);
  if (change === 'source') p.allocations[0].sourceSha256 = 'd'.repeat(64);
  if (change === 'receipt') p.saleEvidenceSha256 = 'd'.repeat(64);
  if (change === 'parent')
    f.db.exec("UPDATE pump_launch_reviews SET receipt='different'");
  if (change === 'slot') p.allocations[0].buySlot = '300';
  if (change === 'over') p.allocations[0].afterRaw = '2001';
  if (change === 'sum') {
    p.allocations[0].unitsRaw = '999';
    p.allocations[0].afterRaw = '999';
  }
  if (change === 'interval') p.allocations[0].afterRaw = '1001';
  if (change === 'flags')
    (p as unknown as Record<string, unknown>).executionAllowed = 0;
  if (change === 'active')
    f.db
      .prepare('INSERT INTO solana_execution_reservations VALUES(?,?)')
      .run('alice', p.wallet);
  if (change === 'legacy')
    f.db
      .prepare('INSERT INTO imported_trade_lot_links VALUES(?,?,?)')
      .run('alice', p.saleReceiptId, p.saleSignature);
  if (change === 'missingUnits')
    delete (p.allocations[0] as Partial<(typeof p.allocations)[0]>).unitsRaw;
  if (change === 'approvedLegacy')
    f.db
      .prepare('UPDATE imported_sale_receipt_evidence SET parent=?')
      .run(
        JSON.stringify({
          approvalDocument: JSON.stringify({ acquisition: {} }),
        }),
      );
  const expected = ['owner', 'receipt', 'approvedLegacy'].includes(change)
    ? 'Retained sale evidence changed'
    : change === 'flags'
      ? 'Invalid launch sale allocation'
      : ['active', 'legacy'].includes(change)
        ? 'Sale already assigned'
        : change === 'sum'
          ? 'Complete sale allocation required'
          : change === 'interval'
            ? 'Launch acquisition interval differs'
            : change === 'missingUnits'
              ? 'Invalid launch acquisition interval'
              : 'Launch acquisition source or consumed units changed';
  expect(() => f.insert(p, change === 'owner' ? 'bob' : 'alice')).toThrow(
    expected,
  );
  expect(
    f.db.prepare('SELECT count(*) AS n FROM launch_sale_allocations').get()!.n,
  ).toBe(0);
});
it('blocks reverse legacy inserts/updates and immutable history mutations', async () => {
  const f = await sqlFixture();
  f.insert(f.p);
  expect(() =>
    f.db
      .prepare('INSERT INTO imported_trade_lot_links VALUES(?,?,?)')
      .run('alice', crypto.randomUUID(), f.p.saleSignature),
  ).toThrow('already assigned');
  f.db
    .prepare('INSERT INTO imported_trade_lot_links VALUES(?,?,?)')
    .run('alice', 'unrelated', 'unrelated');
  expect(() =>
    f.db
      .prepare('UPDATE imported_trade_lot_links SET sell_receipt_id=?')
      .run(f.p.saleReceiptId),
  ).toThrow('already assigned');
  expect(() =>
    f.db.exec('UPDATE launch_sale_allocations SET document=document'),
  ).toThrow('immutable');
  expect(() => f.db.exec('DELETE FROM launch_sale_allocations')).toThrow(
    'immutable',
  );
});
it('SQL admits the full u64 quantity without a floating point or signed-integer sum', async () => {
  const f = await sqlFixture(),
    max = '18446744073709551615';
  const i = {
    ...f.i,
    source: { ...f.i.source, acquiredRaw: max },
    unitsRaw: max,
  };
  const e = { ...f.e, report: { ...f.e.report, acquiredRaw: max } };
  const p = await planLaunchSaleAllocation(e, [i], signal());
  f.db
    .prepare('UPDATE pump_purchase_cost_sources SET source=?')
    .run(JSON.stringify({ ...i.source, packetIndex: 0 }));
  f.db
    .prepare(
      "UPDATE imported_sale_receipt_evidence SET evidence=json_set(evidence,'$.report.acquiredRaw',?)",
    )
    .run(max);
  f.insert(p);
  expect(
    JSON.parse(
      String(
        f.db.prepare('SELECT document FROM launch_sale_allocations').get()!
          .document,
      ),
    ).allocations[0].afterRaw,
  ).toBe(max);
});
