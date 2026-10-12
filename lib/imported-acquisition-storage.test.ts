import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { acquisitionBasketFixture } from '../test/imported-acquisition-basket-fixture';
import { acquisitionId } from '../test/imported-sell-acquisition-fixture';
import type { ImportedAcquisitionBasket } from './imported-acquisition';
let mf: Miniflare, db: D1Database;
const baseline = {
  sequence: 7,
  id: 'f'.repeat(32),
  owner_id: 'previous',
  intent_id: acquisitionId(800),
  preparation_id: acquisitionId(801),
  project_id: acquisitionId(1),
  project_revision: 1,
  wallet_revision: 1,
  wallet_address: acquisitionBasketFixture().wallet,
  type: 'approval.cancelled',
  state: 'cancelled',
  signature: null,
  document: '{ "side": "Buy", "retained": true }',
  created_at: '2026-10-11T00:00:00Z',
  failure_receipt: null,
};
async function migration(name: string) {
  for (const sql of readFileSync(
    new URL('../drizzle/' + name + '.sql', import.meta.url),
    'utf8',
  ).split('--> statement-breakpoint'))
    if (sql.trim()) await db.prepare(sql).run();
}
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'basket-storage',
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
          env: { DB: { type: 'd1', id: 'isolated-basket-storage' } },
        },
      },
    ],
  });
  db = await mf.getD1Database('DB', 'basket-storage');
  for (const sql of [
    'CREATE TABLE imported_token_projects(owner_id TEXT,id TEXT,document TEXT)',
    'CREATE TABLE imported_swap_preparations(id TEXT,owner_id TEXT,project_id TEXT,project_revision INTEGER,wallet_revision INTEGER,wallet_address TEXT,document TEXT)',
    'CREATE TABLE imported_swap_signing_intents(id TEXT PRIMARY KEY,owner_id TEXT,preparation_id TEXT,wallet_address TEXT,document TEXT,state TEXT,signature TEXT,created_at TEXT,updated_at TEXT)',
    'CREATE TABLE imported_swap_receipts(id TEXT,owner_id TEXT,project_id TEXT,intent_id TEXT,document TEXT)',
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT)',
  ])
    await db.prepare(sql).run();
  for (const name of [
    '0048_imported_signing_events',
    '0051_imported_swap_failure',
    '0053_imported_lot_links',
    '0054_imported_approved_acquisition',
  ])
    await migration(name);
  const keys = Object.keys(baseline);
  await db
    .prepare(
      'INSERT INTO imported_swap_signing_events(' +
        keys.join(',') +
        ') VALUES(' +
        keys.map(() => '?').join(',') +
        ')',
    )
    .bind(...Object.values(baseline))
    .run();
  await migration('0055_imported_acquisition_baskets');
});
afterAll(async () => mf?.dispose());
beforeEach(async () => {
  await db.prepare('DELETE FROM imported_swap_signing_intents').run();
  await db.prepare('DELETE FROM imported_swap_preparations').run();
  await db.prepare('DELETE FROM imported_swap_receipts').run();
});
async function seeded(a: ImportedAcquisitionBasket) {
  for (const part of a.allocations)
    await db
      .prepare('INSERT INTO imported_swap_receipts VALUES(?,?,?,?,?)')
      .bind(
        part.buyReceiptId,
        'owner',
        a.projectId,
        'fixture-' + part.buyReceiptId,
        JSON.stringify({
          side: 'Buy',
          wallet: a.wallet,
          mint: a.mint,
          decimals: a.decimals,
          tokenUnitsRaw: part.acquiredRaw,
          signature: part.buySignature,
          preparationSha256: part.buyPreparationSha256,
        }),
      )
      .run();
  const preparationId = acquisitionId(700);
  await db
    .prepare('INSERT INTO imported_swap_preparations VALUES(?,?,?,?,?,?,?)')
    .bind(
      preparationId,
      'owner',
      a.projectId,
      1,
      1,
      a.wallet,
      JSON.stringify({
        side: 'Sell',
        inputMint: a.mint,
        inAmountRaw: a.unitsRaw,
        acquisition: a,
      }),
    )
    .run();
  return (selection = a) =>
    db
      .prepare(
        'INSERT INTO imported_swap_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        acquisitionId(701),
        'owner',
        preparationId,
        a.wallet,
        JSON.stringify({
          sha256: 'a'.repeat(64),
          inputMint: a.mint,
          outputMint: a.wallet,
          inputRaw: a.unitsRaw,
          minimumOutputRaw: '1',
          acquisition: selection,
        }),
        'awaiting_signature',
        '2026-10-11T00:00:00Z',
        '2026-10-11T00:00:00Z',
      )
      .run();
}
it('preserves retained event bytes, sequence and failure field during the capacity migration', async () => {
  expect(
    await db
      .prepare('SELECT * FROM imported_swap_signing_events WHERE sequence=7')
      .first(),
  ).toEqual(baseline);
});
it.each(['correct', 'wrong-total'] as const)(
  'uses exact decimal addition beyond signed SQLite integers with %s evidence',
  async (mode) => {
    const max = (1n << 64n) - 1n,
      a = acquisitionBasketFixture();
    a.linkRevision = 0;
    a.unitsRaw = max.toString();
    a.allocations = a.allocations.map((p, i) => ({
      ...p,
      linkRevision: 0,
      acquiredRaw: max.toString(),
      assignedBeforeRaw: '0',
      unitsRaw:
        i === 0 ? (max - 1n).toString() : mode === 'correct' ? '1' : '2',
    }));
    const write = await seeded(a);
    if (mode === 'correct') {
      expect((await write()).meta.changes).toBeGreaterThan(0);
      expect(
        await db
          .prepare('SELECT COUNT(*) AS n FROM imported_swap_signing_intents')
          .first(),
      ).toEqual({ n: 1 });
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM imported_swap_signing_events WHERE owner_id='owner'",
          )
          .first(),
      ).toEqual({ n: 1 });
    } else {
      await expect(write()).rejects.toThrow();
      expect(
        await db
          .prepare('SELECT COUNT(*) AS n FROM imported_swap_signing_intents')
          .first(),
      ).toEqual({ n: 0 });
    }
  },
);
it('rejects an unregistered partial source assignment even with a current write nonce', async () => {
  const a = acquisitionBasketFixture();
  a.linkRevision = 0;
  a.allocations.forEach((p) => (p.linkRevision = 0));
  await seeded(a);
  const sellId = acquisitionId(750),
    signature = a.allocations[1].buySignature;
  await db
    .prepare('INSERT INTO imported_swap_receipts VALUES(?,?,?,?,?)')
    .bind(
      sellId,
      'owner',
      a.projectId,
      'unregistered',
      JSON.stringify({
        side: 'Sell',
        wallet: a.wallet,
        mint: a.mint,
        decimals: a.decimals,
        tokenUnitsRaw: '3',
        signature,
        preparationSha256: 'a'.repeat(64),
        slot: 10,
        signatureVerified: true,
        network: 'mainnet',
        commitment: 'finalized',
      }),
    )
    .run();
  // Supply normal finalized buy evidence so rejection reaches the partial-source guard.
  await db
    .prepare(
      "UPDATE imported_swap_receipts SET document=json_set(document,'$.slot',1,'$.signatureVerified',1,'$.network','mainnet','$.commitment','finalized') WHERE id=?",
    )
    .bind(a.allocations[0].buyReceiptId)
    .run();
  await db
    .prepare("INSERT INTO imported_trade_lot_gates VALUES(?,?,0,'nonce')")
    .bind('owner', a.projectId)
    .run();
  await expect(
    db
      .prepare(
        'INSERT INTO imported_trade_lot_links VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        acquisitionId(751),
        'owner',
        a.projectId,
        a.allocations[0].buyReceiptId,
        sellId,
        '2',
        a.allocations[0].buySignature,
        signature,
        'a'.repeat(64),
        'a'.repeat(64),
        '2026-10-11T00:00:00Z',
        'nonce',
      )
      .run(),
  ).rejects.toThrow('Partial acquisition');
});
