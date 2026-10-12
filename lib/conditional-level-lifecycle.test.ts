import { beforeAll, afterAll, beforeEach, it, expect } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { conditionalSellTerms } from './conditional-sell-order';
import { captureConditionalPreparation } from './conditional-preparation-server';
import { saveSwapPreparation } from './imported-swap-preparation-history';
import { preparationHistoryFixture } from '../test/imported-preparation-history-fixture';
import {
  acquisitionId as id,
  acquisitionWallet as wallet,
  acquisitionMint as mint,
} from '../test/imported-sell-acquisition-fixture';
let mf: Miniflare, db: D1Database, owner: string;
const projectId = id(1),
  orderId = id(2);
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'conditional-lifecycle-tests',
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
          env: { DB: { type: 'd1', id: 'conditional-lifecycle-test-only' } },
        },
      },
    ],
  });
  db = await mf.getD1Database('DB', 'conditional-lifecycle-tests');
  for (const name of [
    '0024_imported_token_projects',
    '0041_imported_swap_preparations',
    '0045_warmup_signing_intents',
    '0047_shared_swap_reservations',
    '0048_imported_signing_events',
    '0049_native_withdrawals',
    '0051_imported_swap_failure',
    '0053_imported_lot_links',
    '0054_imported_approved_acquisition',
    '0055_imported_acquisition_baskets',
    '0056_conditional_sell_orders',
    '0057_conditional_level_lifecycle',
  ]) {
    for (const sql of readFileSync('drizzle/' + name + '.sql', 'utf8')
      .split('--> statement-breakpoint')
      .filter((s) => s.trim()))
      await db.prepare(sql).run();
  }
  await db
    .prepare(
      'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
    )
    .run();
  await db
    .prepare(
      'CREATE TABLE imported_market_observations(owner_id TEXT,project_id TEXT,document TEXT)',
    )
    .run();
});
afterAll(async () => mf?.dispose());
beforeEach(async () => {
  owner = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .prepare('INSERT INTO imported_token_projects VALUES(?,?,?,?,?,1,0,?,?)')
    .bind(
      owner,
      projectId,
      'Solana',
      mint,
      JSON.stringify({
        token: { chain: 'Solana', address: mint, decimals: 6 },
      }),
      crypto.randomUUID(),
      now,
    )
    .run();
  await db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,1,0)')
    .bind(owner, 'Solana', wallet)
    .run();
  const terms = conditionalSellTerms(
    {
      projectId,
      projectRevision: 1,
      wallet,
      walletRevision: 1,
      pair: mint,
      kind: 'grid',
      direction: 'at-or-above',
      amount: '0.000013',
      minimumUsd: '4064',
      maximumUsd: '4877',
      lines: 5,
    },
    { chain: 'Solana', address: mint, decimals: 6 },
  );
  await db
    .prepare(
      "INSERT INTO conditional_sell_orders VALUES(?,?,?,?,'draft',1,?,?)",
    )
    .bind(owner, orderId, projectId, JSON.stringify(terms), now, now)
    .run();
  await db
    .prepare('INSERT INTO imported_market_observations VALUES(?,?,?)')
    .bind(
      owner,
      projectId,
      JSON.stringify([
        {
          chain: 'Solana',
          address: mint,
          projectRevision: 1,
          source: 'api.dexscreener.com',
          executionAllowed: false,
          observedAt: now,
          pairs: [{ address: mint, marketCapUsd: 4470.5 }],
        },
      ]),
    )
    .run();
});
async function prepared() {
  const context = {
    projectId,
    projectRevision: 1,
    wallet,
    walletRevision: 1,
    mint,
    decimals: 6,
    side: 'Sell',
    unitsRaw: '2',
  };
  const guard = await captureConditionalPreparation(
    db,
    owner,
    { orderId, revision: 1, level: 1 },
    context,
  );
  const document = {
    ...preparationHistoryFixture(),
    wallet,
    inputMint: mint,
    inAmountRaw: '2',
    balance: { ...preparationHistoryFixture().balance, requestedRaw: '2' },
    conditional: guard.selection,
  };
  const saved = await saveSwapPreparation(
    db,
    owner,
    context,
    document,
    undefined,
    guard,
  );
  if (!saved) throw new Error('Fixture preparation unavailable');
  return saved;
}
function approval(prep: Awaited<ReturnType<typeof prepared>>) {
  return {
    id: crypto.randomUUID(),
    preparationId: prep.id,
    wallet,
    inputMint: mint,
    outputMint: prep.document.outputMint,
    inputRaw: '2',
    minimumOutputRaw: prep.document.minimumOutRaw,
    sha256: prep.document.transaction.sha256,
    conditional: prep.document.conditional,
  };
}
async function reserve(review: ReturnType<typeof approval>, ignore = false) {
  const now = new Date().toISOString();
  return db
    .prepare(
      `INSERT ${ignore ? 'OR IGNORE ' : ''}INTO imported_swap_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,created_at,updated_at) VALUES(?,?,?,?,?,'awaiting_signature',?,?)`,
    )
    .bind(
      review.id,
      owner,
      review.preparationId,
      wallet,
      JSON.stringify(review),
      now,
      now,
    )
    .run();
}
const count = async (table: string) =>
  (await db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE owner_id=?`)
    .bind(owner)
    .first<{ count: number }>())!.count;
const transition = (intent: string, state: string) =>
  db
    .prepare(
      'UPDATE imported_swap_signing_intents SET state=?,updated_at=? WHERE owner_id=? AND id=?',
    )
    .bind(state, new Date().toISOString(), owner, intent)
    .run();
const cancelOrder = () =>
  db
    .prepare(
      "UPDATE conditional_sell_orders SET state='cancelled',revision=revision+1,updated_at=? WHERE owner_id=? AND id=?",
    )
    .bind(new Date().toISOString(), owner, orderId)
    .run();
async function signed(review: ReturnType<typeof approval>) {
  await reserve(review);
  await db
    .prepare(
      "UPDATE imported_swap_signing_intents SET signature=?,state='signed' WHERE owner_id=? AND id=?",
    )
    .bind('synthetic-' + review.id, owner, review.id)
    .run();
}
function receiptWrites(review: ReturnType<typeof approval>, changes = {}) {
  const receiptId = crypto.randomUUID(),
    signature = 'synthetic-' + review.id,
    now = new Date().toISOString();
  const document = {
    network: 'mainnet',
    commitment: 'finalized',
    signatureVerified: true,
    signature,
    side: 'Sell',
    wallet,
    mint,
    preparationSha256: review.sha256,
    tokenUnitsRaw: '2',
    ...changes,
  };
  return [
    db
      .prepare('INSERT INTO imported_swap_receipts VALUES(?,?,?,?,?,?,?,?,?,?)')
      .bind(
        receiptId,
        owner,
        review.id,
        review.preparationId,
        projectId,
        1,
        1,
        signature,
        JSON.stringify(document),
        now,
      ),
    db
      .prepare(
        "UPDATE imported_swap_signing_intents SET state='finalized',updated_at=? WHERE owner_id=? AND id=?",
      )
      .bind(now, owner, review.id),
  ];
}
it('atomically reserves a level with shared wallet and event capture and blocks competing edits', async () => {
  const prep = await prepared(),
    review = approval(prep);
  await reserve(review);
  expect(await count('conditional_level_reservations')).toBe(1);
  expect(await count('solana_swap_reservations')).toBe(1);
  expect(await count('imported_swap_signing_events')).toBe(1);
  await expect(cancelOrder()).rejects.toThrow();
  await expect(
    db
      .prepare(
        "UPDATE conditional_sell_orders SET document='{}' WHERE owner_id=? AND id=?",
      )
      .bind(owner, orderId)
      .run(),
  ).rejects.toThrow();
  await expect(prepared()).rejects.toThrow();
  await expect(
    db
      .prepare('DELETE FROM conditional_level_reservations WHERE owner_id=?')
      .bind(owner)
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        "UPDATE imported_swap_preparations SET document='{}' WHERE owner_id=? AND id=?",
      )
      .bind(owner, prep.id)
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        'DELETE FROM imported_swap_signing_intents WHERE owner_id=? AND id=?',
      )
      .bind(owner, review.id)
      .run(),
  ).rejects.toThrow();
});
it('rejects stripped or mismatched approval metadata with no leaked reservations or events', async () => {
  const prep = await prepared();
  for (const change of [
    { conditional: undefined },
    { inputRaw: '3' },
    { sha256: 'a'.repeat(64) },
    { minimumOutputRaw: '1' },
    { conditional: { ...prep.document.conditional, targetUsd: '1' } },
  ]) {
    await expect(
      reserve({ ...approval(prep), ...change } as ReturnType<typeof approval>),
    ).rejects.toThrow();
    expect(await count('conditional_level_reservations')).toBe(0);
    expect(await count('solana_swap_reservations')).toBe(0);
    expect(await count('imported_swap_signing_events')).toBe(0);
  }
});
it('releases cancellation and confirmed failure without consuming a level, and refuses terminal reactivation', async () => {
  const cancelled = approval(await prepared());
  await reserve(cancelled);
  await transition(cancelled.id, 'cancelled');
  expect(await count('conditional_level_reservations')).toBe(0);
  expect(await count('conditional_level_fills')).toBe(0);
  await expect(transition(cancelled.id, 'signed')).rejects.toThrow();
  await expect(
    reserve({ ...cancelled, id: crypto.randomUUID() }, true),
  ).rejects.toThrow();
  expect(await count('solana_swap_reservations')).toBe(0);
  const failed = approval(await prepared());
  await signed(failed);
  await transition(failed.id, 'failed');
  expect(await count('conditional_level_reservations')).toBe(0);
  expect(await count('conditional_level_fills')).toBe(0);
  await cancelOrder();
});
it('finalizes exact receipt, consumes once, releases locks and retains all linked evidence', async () => {
  const prep = await prepared(),
    replacement = await prepared(),
    review = approval(prep);
  await signed(review);
  await db.batch(receiptWrites(review));
  expect(await count('conditional_level_fills')).toBe(1);
  expect(await count('conditional_level_reservations')).toBe(0);
  expect(await count('solana_swap_reservations')).toBe(0);
  await expect(reserve(approval(replacement))).rejects.toThrow();
  expect(await count('solana_swap_reservations')).toBe(0);
  await expect(prepared()).rejects.toThrow();
  for (const sql of [
    'DELETE FROM conditional_level_fills WHERE owner_id=?',
    'DELETE FROM imported_swap_receipts WHERE owner_id=?',
    'DELETE FROM conditional_sell_orders WHERE owner_id=?',
  ])
    await expect(db.prepare(sql).bind(owner).run()).rejects.toThrow();
});
it('withholds finalization without exact finalized evidence and rolls back receipt, state and releases', async () => {
  const review = approval(await prepared());
  await signed(review);
  await expect(transition(review.id, 'finalized')).rejects.toThrow();
  for (const change of [
    { tokenUnitsRaw: '3' },
    { wallet: mint },
    { preparationSha256: 'a'.repeat(64) },
    { commitment: 'confirmed' },
    { signatureVerified: false },
  ])
    await expect(db.batch(receiptWrites(review, change))).rejects.toThrow();
  expect(await count('imported_swap_receipts')).toBe(0);
  expect(await count('conditional_level_fills')).toBe(0);
  expect(await count('conditional_level_reservations')).toBe(1);
});
it('rolls back fill and terminal transition when immutable event persistence fails', async () => {
  const review = approval(await prepared());
  await signed(review);
  await db
    .prepare(
      `CREATE TRIGGER conditional_test_event_failure BEFORE INSERT ON imported_swap_signing_events WHEN NEW.owner_id='${owner}' AND NEW.state='finalized' BEGIN SELECT RAISE(ABORT,'Test event failure'); END`,
    )
    .run();
  try {
    await expect(db.batch(receiptWrites(review))).rejects.toThrow();
  } finally {
    await db.prepare('DROP TRIGGER conditional_test_event_failure').run();
  }
  expect(await count('conditional_level_reservations')).toBe(1);
  expect(await count('conditional_level_fills')).toBe(0);
  expect(await count('imported_swap_receipts')).toBe(0);
  expect(await count('solana_swap_reservations')).toBe(1);
  await db.batch(receiptWrites(review));
  expect(await count('conditional_level_fills')).toBe(1);
});

it('can finalize a previously signed level across project and wallet archival using immutable captured context', async () => {
  const review = approval(await prepared());
  await signed(review);
  await db
    .prepare(
      'UPDATE imported_token_projects SET archived=1,revision=2 WHERE owner_id=?',
    )
    .bind(owner)
    .run();
  await db
    .prepare(
      'UPDATE workspace_wallets SET archived=1,revision=2 WHERE owner_id=?',
    )
    .bind(owner)
    .run();
  await db.batch(receiptWrites(review));
  expect(await count('conditional_level_fills')).toBe(1);
  expect(await count('conditional_level_reservations')).toBe(0);
  expect(await count('solana_swap_reservations')).toBe(0);
});
