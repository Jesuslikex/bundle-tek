import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import { warmupSessionReviewFixture } from '../test/warmup-session-review-fixture';
import { loadWalletWarmupProgress } from './wallet-warmup-progress-server';
import { reviewWalletWarmupSession } from './wallet-warmup-session-review';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';
import {
  readWalletWarmupSessionReview,
  retainWalletWarmupSessionReview,
  type WarmupSessionReviewSelection,
} from './wallet-warmup-session-storage';
let mf: Miniflare,
  db: D1Database,
  fixture: ReturnType<typeof warmupSessionReviewFixture>;
const migration = readFileSync(
  'drizzle/0117_wallet_warmup_session_reviews.sql',
  'utf8',
)
  .split('--> statement-breakpoint')
  .map((sql) => sql.trim())
  .filter(Boolean);
beforeAll(async () => {
  mf = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: 'warmup-session-storage',
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
          env: { DB: { type: 'd1', id: 'warmup-session-storage' } },
        },
      },
    ],
  });
  db = (await mf.getD1Database(
    'DB',
    'warmup-session-storage',
  )) as unknown as D1Database;
  for (const sql of [
    'CREATE TABLE wallet_warmup_plans(owner_id TEXT,id TEXT,revision INTEGER,archived INTEGER,updated_at TEXT,document TEXT,PRIMARY KEY(owner_id,id))',
    'CREATE TABLE workspace_wallets(owner_id TEXT,chain TEXT,address TEXT,revision INTEGER,archived INTEGER)',
    'CREATE TABLE warmup_buy_receipts(owner_id TEXT,plan_id TEXT,id TEXT,plan_revision INTEGER,wallet_revision INTEGER,cycle INTEGER,wallet_address TEXT,signature TEXT,remaining_raw TEXT,document TEXT)',
    'CREATE TABLE warmup_sell_receipts(owner_id TEXT,plan_id TEXT,id TEXT,buy_receipt_id TEXT,consumed_raw TEXT,signature TEXT,document TEXT)',
    'CREATE TABLE solana_swap_reservations(owner_id TEXT,intent_id TEXT,wallet_address TEXT,state TEXT)',
    'CREATE TABLE solana_execution_reservations(owner_id TEXT,wallet_address TEXT,state TEXT)',
  ])
    await db.prepare(sql).run();
});
afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  await db.prepare('DROP TABLE IF EXISTS wallet_warmup_session_reviews').run();
  for (const table of [
    'wallet_warmup_plans',
    'workspace_wallets',
    'warmup_buy_receipts',
    'warmup_sell_receipts',
    'solana_swap_reservations',
    'solana_execution_reservations',
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
  for (const sql of migration) await db.prepare(sql).run();
  fixture = warmupSessionReviewFixture();
  await db
    .prepare('INSERT INTO wallet_warmup_plans VALUES(?,?,?,?,?,?)')
    .bind(
      'one',
      fixture.plan.id,
      1,
      0,
      fixture.plan.updatedAt,
      JSON.stringify(fixture.plan.document),
    )
    .run();
  await db
    .prepare('INSERT INTO workspace_wallets VALUES(?,?,?,?,?)')
    .bind('one', 'Solana', fixture.plan.document.addresses[0], 1, 0)
    .run();
});
const signal = () => new AbortController().signal;
const count = async () =>
  (await db
    .prepare('SELECT count(*) AS n FROM wallet_warmup_session_reviews')
    .first<{ n: number }>())!.n;
async function selection(): Promise<WarmupSessionReviewSelection> {
  const current = await loadWalletWarmupProgress(
      db,
      'one',
      fixture.plan.id,
      1,
      false,
      true,
    ),
    at = Date.now(),
    review = reviewWalletWarmupSession(
      current.plan,
      current.progress,
      current.performance,
      at,
    );
  return {
    id: crypto.randomUUID(),
    planId: fixture.plan.id,
    revision: 1,
    reviewedAt: new Date(at).toISOString(),
    reviewSha256: await digest(review.contextKey),
  };
}
async function save(input?: WarmupSessionReviewSelection, database = db) {
  return retainWalletWarmupSessionReview(
    database,
    'one',
    input ?? (await selection()),
    true,
    signal(),
  );
}
async function addBuy(n = 3, cycle = 1, padding = '') {
  const wallet = fixture.plan.document.addresses[0],
    mint = fixture.plan.document.tokens[0];
  const document = {
    signatureVerified: true,
    signature: bs58.encode(new Uint8Array(64).fill(n)),
    wallet,
    mint,
    decimals: 6,
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    slot: n,
    preparationSha256: 'a'.repeat(64),
    nativeSettlementRaw: '-1000000',
    networkFeeLamports: '5000',
    rentChangeRaw: '0',
    acquiredRaw: '10',
    commitment: 'finalized',
    network: 'mainnet',
    padding,
  };
  await db
    .prepare('INSERT INTO warmup_buy_receipts VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind(
      'one',
      fixture.plan.id,
      `lot-${n}`,
      1,
      1,
      cycle,
      wallet,
      document.signature,
      '10',
      JSON.stringify(document),
    )
    .run();
}
function withInsertHook(hook: () => Promise<void>, lostResponse = false) {
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith('INSERT INTO wallet_warmup_session_reviews'))
            return statement;
          return {
            bind(...values: Parameters<D1PreparedStatement['bind']>) {
              const bound = statement.bind(...values);
              return {
                run: async () => {
                  await hook();
                  const result = await bound.run();
                  if (lostResponse) throw Error('Synthetic lost response');
                  return result;
                },
              } as D1PreparedStatement;
            },
          } as D1PreparedStatement;
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
it('retains and cryptographically replays an immutable owner-scoped review without execution authority', async () => {
  const input = await selection(),
    result = await save(input);
  expect(result.id).toBe(input.id);
  expect(result.document.actions).toHaveLength(4);
  expect(result.document).toMatchObject({
    executionAllowed: false,
    signingAllowed: false,
    automaticExecutionAllowed: false,
  });
  expect(await readWalletWarmupSessionReview(db, 'one', input.id)).toEqual(
    result,
  );
  expect(await readWalletWarmupSessionReview(db, 'two', input.id)).toBeNull();
  expect(await count()).toBe(1);
  expect(JSON.stringify(result)).not.toContain('planDocument');
  expect(JSON.stringify(result)).not.toContain('contextKey');
});
it('requires an explicit save request and a fresh exact review hash', async () => {
  const input = await selection();
  await expect(
    retainWalletWarmupSessionReview(db, 'one', input, false, signal()),
  ).rejects.toThrow('explicit');
  await expect(
    save({ ...input, reviewSha256: '0'.repeat(64) }),
  ).rejects.toThrow('changed');
  await expect(
    retainWalletWarmupSessionReview(
      db,
      'one',
      input,
      true,
      signal(),
      () => Date.now() + 61000,
    ),
  ).rejects.toThrow('expired');
  expect(await count()).toBe(0);
});
it('recovers the same retained identity after expiry and archival without saving or approving again', async () => {
  const input = await selection(),
    result = await save(input);
  await db
    .prepare('UPDATE wallet_warmup_plans SET archived=1,revision=2')
    .run();
  await db.prepare('UPDATE workspace_wallets SET archived=1,revision=2').run();
  expect(
    await retainWalletWarmupSessionReview(
      db,
      'one',
      input,
      true,
      signal(),
      () => Date.now() + 120000,
    ),
  ).toEqual(result);
  expect(await count()).toBe(1);
});
it('never replaces an identity with a different hash or duplicates one snapshot under a new id', async () => {
  const input = await selection();
  await save(input);
  await expect(
    save({ ...input, reviewSha256: '0'.repeat(64) }),
  ).rejects.toThrow('different retained');
  await expect(save({ ...input, id: crypto.randomUUID() })).rejects.toThrow(
    'already retained',
  );
  expect(await count()).toBe(1);
});
it('recovers a committed insert after a lost response without a second write', async () => {
  const input = await selection();
  let attempts = 0;
  const result = await save(
    input,
    withInsertHook(async () => {
      attempts++;
    }, true),
  );
  expect(result.id).toBe(input.id);
  expect(attempts).toBe(1);
  expect(await count()).toBe(1);
});
it.each([
  'plan',
  'wallet',
  'receipt-added',
  'remaining-units',
  'execution-lock',
] as const)('refuses an insertion-time baseline race: %s', async (kind) => {
  if (kind === 'remaining-units') await addBuy();
  const input = await selection();
  const raced = withInsertHook(async () => {
    if (kind === 'plan')
      await db.prepare('UPDATE wallet_warmup_plans SET revision=2').run();
    if (kind === 'wallet')
      await db.prepare('UPDATE workspace_wallets SET revision=2').run();
    if (kind === 'receipt-added') await addBuy();
    if (kind === 'remaining-units')
      await db
        .prepare("UPDATE warmup_buy_receipts SET remaining_raw='9'")
        .run();
    if (kind === 'execution-lock')
      await db
        .prepare('INSERT INTO solana_execution_reservations VALUES(?,?,?)')
        .bind('one', fixture.plan.document.addresses[0], 'submitted')
        .run();
  });
  await expect(save(input, raced)).rejects.toThrow(/changed|retained/);
  expect(await count()).toBe(0);
});
it('preserves exact partial-lot context and already-counted costs in the retained manifest', async () => {
  await addBuy();
  const result = await save();
  expect(
    result.document.actions.filter((action) => action.cycle === 1),
  ).toMatchObject([
    {
      side: 'Sell',
      source: { kind: 'saved-buy', buyReceiptId: 'lot-3', remainingRaw: '10' },
    },
  ]);
  expect(result.document.wallets[0]).toMatchObject({
    recordedNetworkFeesLamports: '5000',
    remainingFeeReserveLamports: '9995000',
  });
});
it('retains linked finalized sells and excludes their consumed units from future actions', async () => {
  await addBuy();
  const buy = await db
    .prepare('SELECT document FROM warmup_buy_receipts')
    .first<{ document: string }>();
  const document = {
    ...JSON.parse(buy!.document),
    signature: bs58.encode(new Uint8Array(64).fill(4)),
    slot: 4,
    nativeSettlementRaw: '400000',
    buyReceiptId: 'lot-3',
    consumedRaw: '4',
  };
  await db.prepare("UPDATE warmup_buy_receipts SET remaining_raw='6'").run();
  await db
    .prepare('INSERT INTO warmup_sell_receipts VALUES(?,?,?,?,?,?,?)')
    .bind(
      'one',
      fixture.plan.id,
      'sell-4',
      'lot-3',
      '4',
      document.signature,
      JSON.stringify(document),
    )
    .run();
  const input = await selection(),
    retained = await save(input);
  expect(retained.document.actions.filter((a) => a.cycle === 1)).toMatchObject([
    { side: 'Sell', source: { kind: 'saved-buy', remainingRaw: '6' } },
  ]);
  expect(retained.document.wallets[0].recordedNetworkFeesLamports).toBe(
    '10000',
  );
  expect(await readWalletWarmupSessionReview(db, 'one', input.id)).toEqual(
    retained,
  );
});
it.each([
  'signingAllowed',
  'executionAllowed',
  'automaticExecutionAllowed',
  'dependency',
  'source',
] as const)(
  'rejects direct SQL attempts to bypass the snapshot guard: %s',
  async (kind) => {
    await save();
    const row = await db
      .prepare('SELECT * FROM wallet_warmup_session_reviews')
      .first<Record<string, unknown>>();
    const changed: Record<string, unknown> = {
      ...row,
      id: crypto.randomUUID(),
      review_sha256: 'f'.repeat(64),
    };
    const document = JSON.parse(changed.document as string);
    document.contextSha256 = changed.review_sha256;
    if (kind === 'dependency')
      document.actions[1].source.actionId = 'absent-buy';
    else if (kind === 'source') {
      const source = JSON.parse(changed.source as string);
      source.planDocument = '{}';
      changed.source = JSON.stringify(source);
    } else document[kind] = true;
    changed.document = JSON.stringify(document);
    const keys = Object.keys(changed);
    await expect(
      db
        .prepare(
          `INSERT INTO wallet_warmup_session_reviews(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
        )
        .bind(...keys.map((k) => changed[k as keyof typeof changed]))
        .run(),
    ).rejects.toThrow();
    expect(await count()).toBe(1);
  },
);
it('blocks UPDATE, DELETE and INSERT OR REPLACE so audit history cannot be rewritten', async () => {
  await save();
  await expect(
    db.prepare("UPDATE wallet_warmup_session_reviews SET document='{}'").run(),
  ).rejects.toThrow();
  await expect(
    db.prepare('DELETE FROM wallet_warmup_session_reviews').run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        'INSERT OR REPLACE INTO wallet_warmup_session_reviews SELECT * FROM wallet_warmup_session_reviews',
      )
      .run(),
  ).rejects.toThrow();
  expect(await count()).toBe(1);
});
it('withholds storage when its immutable triggers are unavailable', async () => {
  const input = await selection();
  await db
    .prepare('DROP TRIGGER wallet_warmup_session_reviews_no_update')
    .run();
  await expect(save(input)).rejects.toThrow('not installed');
  expect(await count()).toBe(0);
});
it('rejects corrupt retained source even if an out-of-band edit bypassed and restored the SQL guard', async () => {
  const input = await selection();
  await save(input);
  await db
    .prepare('DROP TRIGGER wallet_warmup_session_reviews_no_update')
    .run();
  await db
    .prepare(
      "UPDATE wallet_warmup_session_reviews SET source=json_set(source,'$.planUpdatedAt','tampered')",
    )
    .run();
  await db
    .prepare(
      "CREATE TRIGGER wallet_warmup_session_reviews_no_update BEFORE UPDATE ON wallet_warmup_session_reviews BEGIN SELECT RAISE(ABORT,'immutable'); END",
    )
    .run();
  await expect(
    readWalletWarmupSessionReview(db, 'one', input.id),
  ).rejects.toThrow('evidence is unavailable or differs');
});
it('rejects cancelled saves without inserting anything', async () => {
  const input = await selection(),
    controller = new AbortController();
  controller.abort();
  await expect(
    retainWalletWarmupSessionReview(db, 'one', input, true, controller.signal),
  ).rejects.toThrow();
  expect(await count()).toBe(0);
});
it('bounds retained source bytes without saving a partial snapshot', async () => {
  await addBuy(3, 1, 'ü'.repeat(530000));
  const input = await selection();
  await expect(save(input)).rejects.toThrow('snapshot capacity');
  expect(await count()).toBe(0);
});
