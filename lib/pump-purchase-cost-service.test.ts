import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { pumpPurchaseSettlementFixture } from '../test/pump-purchase-settlement-fixture';
import { pumpGroupPaymentFixture } from '../test/pump-group-payment-fixture';
import { preflightOwnedPumpCreate } from './owned-pump-preflight';
import { recoverOwnedPumpGroupBroadcast } from './pump-group-broadcast-recovery';
import { retainOwnedPumpGroupReceiptEvidence } from './pump-group-receipt-evidence-service';
import {
  readOwnedPumpPurchaseCostPlan,
  recordOwnedPumpPurchaseCosts,
  readOwnedPumpPurchaseCostHistory,
} from './pump-purchase-cost-service';
import { canonicalPumpHolderJson } from './pump-holder-review';
import { pumpHolderDigest } from './pump-holder-review';
import type { PumpLaunchRpc } from './pump-launch-simulation';
vi.mock('./owned-pump-preflight', async (original) => ({
  ...(await original<typeof import('./owned-pump-preflight')>()),
  preflightOwnedPumpCreate: vi.fn(),
}));
vi.mock('./pump-group-code-identity', async (original) => ({
  ...(await original<typeof import('./pump-group-code-identity')>()),
  collectPumpProgramIdentities: vi.fn(),
}));
const clients: Client[] = [],
  signal = () => new AbortController().signal;
let f: Awaited<ReturnType<typeof pumpPurchaseSettlementFixture>>,
  rpc: PumpLaunchRpc,
  receiptId: string;
beforeAll(async () => {
  f = await pumpPurchaseSettlementFixture(
    vi.mocked(preflightOwnedPumpCreate),
    clients,
  );
  await f.ready();
  const signed = f.group.signedEvidence!;
  const payment = await pumpGroupPaymentFixture(false, 'create', {
    review: f.group.review,
    signed,
    group: { review: f.group.review, signedEvidence: signed },
    rpc: f.rpc,
  });
  f.control.chain = true;
  rpc = async (m, p, s) => {
    if (
      m === 'getTransaction' &&
      signed.packets.some((t) => t.signature === p[0])
    ) {
      const result = (await payment.rpc(m, p, s)) as { slot: string };
      result.slot = '250';
      return result;
    }
    return f.rpc(m, p, s);
  };
  await recoverOwnedPumpGroupBroadcast(
    f.db,
    'alice',
    f.group.review.id,
    signal(),
    rpc,
    f.jito,
  );
  await f.client.execute(
    'CREATE TABLE imported_token_project_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
  );
  for (const name of [
    '0113_pump_group_receipt_evidence',
    '0114_pump_purchase_cost_sources',
  ])
    for (const sql of readFileSync(`drizzle/${name}.sql`, 'utf8').split(
      '--> statement-breakpoint',
    ))
      if (sql.trim())
        await f.client.execute(
          sql.replaceAll(
            "julianday('now')",
            "julianday('2026-10-15T12:00:00.000Z')",
          ),
        );
  receiptId = await capture();
}, 120000);
afterAll(() => {
  for (const c of clients) c.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function capture(partial = false) {
  await f.client.execute('DELETE FROM imported_token_project_gates');
  const id = crypto.randomUUID();
  await retainOwnedPumpGroupReceiptEvidence(
    f.db,
    'alice',
    f.group.review.id,
    id,
    signal(),
    async (m, p, s) =>
      partial &&
      m === 'getTransaction' &&
      p[0] === f.group.signedEvidence!.packets[1].signature
        ? null
        : rpc(m, p, s),
  );
  return id;
}
const consent = (receipt: string, sha: string) => ({
  receiptId: receipt,
  planSha256: sha,
  approved: true as const,
  policy: 'reviewed-buy-shares-v1' as const,
});
async function count(table: string) {
  return (await f.client.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0]
    .n;
}
it('uses real retained terminal/receipt proofs and owner-scoped database-only previews', async () => {
  const reads = f.reads.length,
    sends = f.sends.length;
  const p = await readOwnedPumpPurchaseCostPlan(
    f.db,
    'alice',
    f.group.review.id,
    receiptId,
    signal(),
  );
  expect(p.plan.sources).toHaveLength(18);
  expect(p.saved).toBe(false);
  expect(p.recordedOriginIds).toEqual([]);
  for (const bad of [
    { ...consent(receiptId, p.plan.sha256), policy: 'payer-only' },
    { ...consent(receiptId, p.plan.sha256), amount: '1' },
    { ...consent(receiptId, p.plan.sha256), approved: false },
  ])
    await expect(
      recordOwnedPumpPurchaseCosts(
        f.db,
        'alice',
        f.group.review.id,
        bad as never,
        signal(),
      ),
    ).rejects.toThrow('approval');
  expect(p.plan.allocationComplete).toBe(true);
  expect(
    await readOwnedPumpPurchaseCostHistory(
      f.db,
      'alice',
      f.group.review.id,
      signal(),
    ),
  ).toMatchObject({
    sources: [],
    executionAllowed: false,
    profitCalculated: false,
  });
  await expect(
    readOwnedPumpPurchaseCostPlan(
      f.db,
      'bob',
      f.group.review.id,
      receiptId,
      signal(),
    ),
  ).rejects.toThrow();
  await expect(
    recordOwnedPumpPurchaseCosts(
      f.db,
      'alice',
      f.group.review.id,
      { ...consent(receiptId, p.plan.sha256), approved: false } as never,
      signal(),
    ),
  ).rejects.toThrow('approval');
  await expect(
    recordOwnedPumpPurchaseCosts(
      f.db,
      'alice',
      f.group.review.id,
      consent(receiptId, '0'.repeat(64)),
      signal(),
    ),
  ).rejects.toThrow('changed');
  expect(await count('pump_purchase_cost_batches')).toBe(0);
  expect(f.reads.length).toBe(reads);
  expect(f.sends.length).toBe(sends);
});
it('atomically saves exact origins, recovers repeated consent and never changes launch authority', async () => {
  const p = await readOwnedPumpPurchaseCostPlan(
    f.db,
    'alice',
    f.group.review.id,
    receiptId,
    signal(),
  );
  const before = (await f.client.execute('SELECT * FROM pump_launch_reviews'))
    .rows;
  const saved = await recordOwnedPumpPurchaseCosts(
    f.db,
    'alice',
    f.group.review.id,
    consent(receiptId, p.plan.sha256),
    signal(),
  );
  expect(saved.saved).toBe(true);
  expect(saved.recordedOriginIds).toHaveLength(18);
  expect(await count('pump_purchase_cost_sources')).toBe(18);
  expect(await count('pump_purchase_cost_batches')).toBe(1);
  expect(
    await recordOwnedPumpPurchaseCosts(
      f.db,
      'alice',
      f.group.review.id,
      consent(receiptId, p.plan.sha256),
      signal(),
    ),
  ).toEqual(saved);
  expect(
    (await f.client.execute('SELECT * FROM pump_launch_reviews')).rows,
  ).toEqual(before);
  const history = await readOwnedPumpPurchaseCostHistory(
    f.db,
    'alice',
    f.group.review.id,
    signal(),
  );
  expect(history.sources).toEqual(
    [...p.plan.sources].sort((a, b) => a.originId.localeCompare(b.originId)),
  );
  for (const table of [
    'pump_purchase_cost_sources',
    'pump_purchase_cost_batches',
  ]) {
    await expect(f.client.execute(`DELETE FROM ${table}`)).rejects.toThrow(
      'immutable',
    );
    await expect(
      f.client.execute(`UPDATE ${table} SET owner_id=owner_id`),
    ).rejects.toThrow('immutable');
  }
});
it('recovers a lost committed response without duplicating the same origins across snapshots', async () => {
  const id = await capture(),
    p = await readOwnedPumpPurchaseCostPlan(
      f.db,
      'alice',
      f.group.review.id,
      id,
      signal(),
    );
  const lost = {
    prepare: f.db.prepare.bind(f.db),
    batch: async (statements: D1PreparedStatement[]) => {
      await f.db.batch(statements);
      throw Error('synthetic lost database response');
    },
  } as unknown as D1Database;
  const saved = await recordOwnedPumpPurchaseCosts(
    lost,
    'alice',
    f.group.review.id,
    consent(id, p.plan.sha256),
    signal(),
  );
  expect(saved.saved).toBe(true);
  expect(await count('pump_purchase_cost_batches')).toBe(2);
  expect(await count('pump_purchase_cost_sources')).toBe(18);
});
it('handles simultaneous identical saves through the real atomic adapter', async () => {
  const id = await capture(),
    p = await readOwnedPumpPurchaseCostPlan(
      f.db,
      'alice',
      f.group.review.id,
      id,
      signal(),
    );
  const values = await Promise.all(
    [1, 2].map(() =>
      recordOwnedPumpPurchaseCosts(
        f.db,
        'alice',
        f.group.review.id,
        consent(id, p.plan.sha256),
        signal(),
      ),
    ),
  );
  expect(values[0]).toEqual(values[1]);
  expect(await count('pump_purchase_cost_batches')).toBe(3);
  expect(await count('pump_purchase_cost_sources')).toBe(18);
});
it('rolls back the batch if any source insert fails and can safely retry afterward', async () => {
  const id = await capture(),
    p = await readOwnedPumpPurchaseCostPlan(
      f.db,
      'alice',
      f.group.review.id,
      id,
      signal(),
    );
  const broken = {
    prepare: f.db.prepare.bind(f.db),
    batch: async (statements: D1PreparedStatement[]) =>
      f.db.batch([
        ...statements,
        f.db.prepare(
          "INSERT INTO pump_purchase_cost_sources(owner_id,origin_id,receipt_id,review_id,mint,wallet,source,sha256) VALUES('mallory','bad','bad','bad','bad','bad','{}','bad')",
        ),
      ]),
  } as D1Database;
  await expect(
    recordOwnedPumpPurchaseCosts(
      broken,
      'alice',
      f.group.review.id,
      consent(id, p.plan.sha256),
      signal(),
    ),
  ).rejects.toThrow('could not be saved');
  expect(await count('pump_purchase_cost_batches')).toBe(3);
  expect(await count('pump_purchase_cost_sources')).toBe(18);
  expect(
    (
      await recordOwnedPumpPurchaseCosts(
        f.db,
        'alice',
        f.group.review.id,
        consent(id, p.plan.sha256),
        signal(),
      )
    ).saved,
  ).toBe(true);
});
it('preserves the original complete sources when a newer selected receipt is incomplete', async () => {
  const id = await capture(true),
    p = await readOwnedPumpPurchaseCostPlan(
      f.db,
      'alice',
      f.group.review.id,
      id,
      signal(),
    );
  expect(p.plan.sources.length).toBeLessThan(18);
  expect(p.plan.omitted.length).toBeGreaterThan(0);
  await recordOwnedPumpPurchaseCosts(
    f.db,
    'alice',
    f.group.review.id,
    consent(id, p.plan.sha256),
    signal(),
  );
  let terminalObservationReads = 0;
  const cachedDb = {
    prepare(sql: string) {
      if (
        sql.includes(
          'FROM pump_group_observations WHERE owner_id=? AND review_id=? AND id=?',
        )
      )
        terminalObservationReads++;
      return f.db.prepare(sql);
    },
  } as D1Database;
  expect(
    (
      await readOwnedPumpPurchaseCostHistory(
        cachedDb,
        'alice',
        f.group.review.id,
        signal(),
      )
    ).sources,
  ).toHaveLength(18);
  expect(terminalObservationReads).toBe(1);
  expect(await count('pump_purchase_cost_sources')).toBe(18);
});
it('rejects source conflicts at the database boundary without changing any original units', async () => {
  const row = (
    await f.client.execute('SELECT * FROM pump_purchase_cost_sources LIMIT 1')
  ).rows[0];
  if (typeof row.source !== 'string')
    throw new Error('Expected retained source JSON.');
  const source = JSON.parse(row.source);
  source.acquiredRaw = '1';
  await expect(
    f.client.execute({
      sql: 'INSERT OR IGNORE INTO pump_purchase_cost_sources(owner_id,origin_id,receipt_id,review_id,mint,wallet,source,sha256) VALUES(?,?,?,?,?,?,?,?)',
      args: [
        row.owner_id,
        row.origin_id,
        row.receipt_id,
        row.review_id,
        row.mint,
        row.wallet,
        canonicalPumpHolderJson(source),
        row.sha256,
      ],
    }),
  ).rejects.toThrow();
  expect(
    (
      await f.client.execute({
        sql: 'SELECT source FROM pump_purchase_cost_sources WHERE owner_id=? AND origin_id=?',
        args: [row.owner_id, row.origin_id],
      })
    ).rows[0].source,
  ).toBe(row.source);
});
it('rejects a changed source even when it belongs to a self-consistent new batch, atomically', async () => {
  const id = await capture(),
    old = (
      await f.client.execute('SELECT * FROM pump_purchase_cost_batches LIMIT 1')
    ).rows[0];
  if (typeof old.plan !== 'string')
    throw new Error('Expected retained plan JSON.');
  const plan = JSON.parse(old.plan),
    source = plan.sources[0];
  source.acquiredRaw = '1';
  const { sha256: _sourceSha, ...sourceCore } = source;
  source.sha256 = await pumpHolderDigest(sourceCore);
  const { sha256: _planSha, ...planCore } = plan;
  plan.sha256 = await pumpHolderDigest(planCore);
  const before = await count('pump_purchase_cost_batches');
  await expect(
    f.db.batch([
      f.db
        .prepare(
          'INSERT INTO pump_purchase_cost_batches(owner_id,receipt_id,review_id,parent,costs,plan,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .bind(
          'alice',
          id,
          f.group.review.id,
          old.parent,
          old.costs,
          canonicalPumpHolderJson(plan),
          plan.sha256,
          new Date().toISOString(),
        ),
      f.db
        .prepare(
          'INSERT OR IGNORE INTO pump_purchase_cost_sources(owner_id,origin_id,receipt_id,review_id,mint,wallet,source,sha256) VALUES(?,?,?,?,?,?,?,?)',
        )
        .bind(
          'alice',
          source.originId,
          id,
          f.group.review.id,
          source.mint,
          source.wallet,
          canonicalPumpHolderJson(source),
          source.sha256,
        ),
    ]),
  ).rejects.toThrow('already has different');
  expect(await count('pump_purchase_cost_batches')).toBe(before);
  expect(await count('pump_purchase_cost_sources')).toBe(18);
});
it('recovers an aborted committed record by its natural receipt identity', async () => {
  const id = await capture(),
    p = await readOwnedPumpPurchaseCostPlan(
      f.db,
      'alice',
      f.group.review.id,
      id,
      signal(),
    ),
    controller = new AbortController();
  const interrupted = {
    prepare: f.db.prepare.bind(f.db),
    batch: async (statements: D1PreparedStatement[]) => {
      const result = await f.db.batch(statements);
      controller.abort();
      return result;
    },
  } as D1Database;
  await expect(
    recordOwnedPumpPurchaseCosts(
      interrupted,
      'alice',
      f.group.review.id,
      consent(id, p.plan.sha256),
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(
    (
      await readOwnedPumpPurchaseCostPlan(
        f.db,
        'alice',
        f.group.review.id,
        id,
        signal(),
      )
    ).saved,
  ).toBe(true);
  expect(await count('pump_purchase_cost_sources')).toBe(18);
});
it('fails closed if storage guards or original terminal proof have been removed or corrupted', async () => {
  await f.client.execute('DROP TRIGGER pump_purchase_cost_batches_no_update');
  try {
    await expect(
      readOwnedPumpPurchaseCostHistory(
        f.db,
        'alice',
        f.group.review.id,
        signal(),
      ),
    ).rejects.toThrow('not installed');
  } finally {
    await f.client.execute(
      "CREATE TRIGGER pump_purchase_cost_batches_no_update BEFORE UPDATE ON pump_purchase_cost_batches BEGIN SELECT RAISE(ABORT,'Launch buy cost history is immutable'); END;",
    );
  }
  const old = (
    await f.client.execute(
      'SELECT id,sha256 FROM pump_group_observations LIMIT 1',
    )
  ).rows[0];
  await f.client.execute('DROP TRIGGER pump_group_observation_no_update');
  await f.client.execute({
    sql: 'UPDATE pump_group_observations SET sha256=? WHERE id=?',
    args: ['0'.repeat(64), old.id],
  });
  try {
    await expect(
      readOwnedPumpPurchaseCostPlan(
        f.db,
        'alice',
        f.group.review.id,
        receiptId,
        signal(),
      ),
    ).rejects.toThrow();
  } finally {
    await f.client.execute({
      sql: 'UPDATE pump_group_observations SET sha256=? WHERE id=?',
      args: [old.sha256, old.id],
    });
    await f.client.execute(
      "CREATE TRIGGER pump_group_observation_no_update BEFORE UPDATE ON pump_group_observations BEGIN SELECT RAISE(ABORT,'Immutable group observation'); END;",
    );
  }
  const controller = new AbortController();
  controller.abort();
  await expect(
    readOwnedPumpPurchaseCostHistory(
      f.db,
      'alice',
      f.group.review.id,
      controller.signal,
    ),
  ).rejects.toThrow();
});
it('rejects parent drift before reusing a request-local terminal proof', async () => {
  let parentReads = 0;
  const drifting = {
    prepare(sql: string) {
      const statement = f.db.prepare(sql);
      if (
        sql !==
        'SELECT review,signed,signature,state,receipt FROM pump_launch_reviews WHERE owner_id=? AND id=?'
      )
        return statement;
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            async first() {
              const value = await bound.first<Record<string, unknown>>();
              return ++parentReads === 2
                ? { ...value, state: 'changed' }
                : value;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  await expect(
    readOwnedPumpPurchaseCostHistory(
      drifting,
      'alice',
      f.group.review.id,
      signal(),
    ),
  ).rejects.toThrow('changed after');
  expect(parentReads).toBe(2);
});
it('refuses an empty-looking history when a tampered database lost the recorded sources', async () => {
  // Deliberately damaged disposable fixture only; production history is immutable.
  await f.client.execute('DROP TRIGGER pump_purchase_cost_sources_no_delete');
  await f.client.execute('DELETE FROM pump_purchase_cost_sources');
  await f.client.execute(
    "CREATE TRIGGER pump_purchase_cost_sources_no_delete BEFORE DELETE ON pump_purchase_cost_sources BEGIN SELECT RAISE(ABORT,'Launch buy cost source is immutable'); END;",
  );
  await expect(
    readOwnedPumpPurchaseCostHistory(
      f.db,
      'alice',
      f.group.review.id,
      signal(),
    ),
  ).rejects.toThrow('capacity differs');
});
