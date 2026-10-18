import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Client } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { pumpPurchaseSettlementFixture } from '../test/pump-purchase-settlement-fixture';
import { pumpGroupPaymentFixture } from '../test/pump-group-payment-fixture';
import { importedSaleEvidenceFixture } from '../test/imported-sale-evidence-fixture';
import { preflightOwnedPumpCreate } from './owned-pump-preflight';
import { recoverOwnedPumpGroupBroadcast } from './pump-group-broadcast-recovery';
import { retainOwnedPumpGroupReceiptEvidence } from './pump-group-receipt-evidence-service';
import {
  readOwnedPumpPurchaseCostPlan,
  recordOwnedPumpPurchaseCosts,
} from './pump-purchase-cost-service';
import { retainOwnedImportedSaleEvidence } from './imported-sale-evidence-service';
import {
  reviewOwnedLaunchSaleAllocation as review,
  recordOwnedLaunchSaleAllocation as record,
  readOwnedLaunchSaleAllocation as read,
} from './launch-sale-allocation-service';
import { LAUNCH_SALE_POLICY } from './launch-sale-allocation';
import {
  GET as getRoute,
  POST as postRoute,
} from '@/app/api/account-launch-activity/sale-allocations/route';
import {
  canonicalPumpHolderJson as canonical,
  pumpHolderDigest,
} from './pump-holder-review';
const http = vi.hoisted(() => ({ db: null as unknown as D1Database }));
vi.mock('@/app/chatgpt-auth', () => ({
  getChatGPTUser: async () => ({ userId: 'alice' }),
}));
vi.mock('@/db', () => ({ getD1: () => http.db }));
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
let g: Awaited<ReturnType<typeof pumpPurchaseSettlementFixture>>,
  origin: string;
const sales: Awaited<ReturnType<typeof importedSaleEvidenceFixture>>[] = [];
async function migration(name: string) {
  for (const sql of readFileSync(`drizzle/${name}.sql`, 'utf8').split(
    '--> statement-breakpoint',
  ))
    if (sql.trim())
      await g.client.execute(
        sql.replaceAll(
          "julianday('now')",
          "julianday('2026-10-15T12:00:00.000Z')",
        ),
      );
}
beforeAll(async () => {
  g = await pumpPurchaseSettlementFixture(
    vi.mocked(preflightOwnedPumpCreate),
    clients,
  );
  await g.ready();
  const signed = g.group.signedEvidence!;
  const payment = await pumpGroupPaymentFixture(false, 'create', {
    review: g.group.review,
    signed,
    group: { review: g.group.review, signedEvidence: signed },
    rpc: g.rpc,
  });
  g.control.chain = true;
  const rpc: typeof g.rpc = async (m, p, s) => {
    if (
      m === 'getTransaction' &&
      signed.packets.some((t) => t.signature === p[0])
    ) {
      const result = (await payment.rpc(m, p, s)) as { slot: string };
      result.slot = '250';
      return result;
    }
    return g.rpc(m, p, s);
  };
  await recoverOwnedPumpGroupBroadcast(
    g.db,
    'alice',
    g.group.review.id,
    signal(),
    rpc,
    g.jito,
  );
  await g.client.execute(
    'CREATE TABLE imported_token_project_gates(owner_id TEXT PRIMARY KEY,next_allowed_at INTEGER)',
  );
  await migration('0113_pump_group_receipt_evidence');
  await migration('0114_pump_purchase_cost_sources');
  const receiptId = crypto.randomUUID();
  await retainOwnedPumpGroupReceiptEvidence(
    g.db,
    'alice',
    g.group.review.id,
    receiptId,
    signal(),
    rpc,
  );
  const costs = await readOwnedPumpPurchaseCostPlan(
    g.db,
    'alice',
    g.group.review.id,
    receiptId,
    signal(),
  );
  await recordOwnedPumpPurchaseCosts(
    g.db,
    'alice',
    g.group.review.id,
    {
      receiptId,
      planSha256: costs.plan.sha256,
      approved: true,
      policy: 'reviewed-buy-shares-v1',
    },
    signal(),
  );
  const signers = [g.f.f.payerSigner, ...g.holderSigners];
  const chosen = costs.plan.sources.find((s) =>
    signers.some((k) => k.address === s.wallet),
  )!;
  if (!chosen) throw Error('No matching synthetic launch signer');
  origin = chosen.originId;
  const signer = signers.find((k) => k.address === chosen.wallet)!;
  for (const options of [
    {},
    { seed: true },
    { keepWrapped: true },
    { seed: true, initializer: 16 as const },
    { seed: true, initializer: 1 as const },
    { fee: 50 },
  ])
    sales.push(
      await importedSaleEvidenceFixture(true, {
        signer,
        mint: chosen.mint,
        ...options,
      }),
    );
  // Original legacy admission is outside this fixture. Retain an acquisition
  // marker on the fifth approval to verify it cannot be reassigned if its old
  // lot rows are missing. The signed Metis packet/receipt still replay normally.
  const oldApproval = JSON.parse(sales[4].p.approvalDocument);
  oldApproval.acquisition = { kind: 'basket', allocations: [] };
  sales[4].p.approvalDocument = JSON.stringify(oldApproval);
  for (const name of [
    '0041_imported_swap_preparations',
    '0047_shared_swap_reservations',
    '0053_imported_lot_links',
  ])
    for (const sql of readFileSync(`drizzle/${name}.sql`, 'utf8').split(
      '--> statement-breakpoint',
    ))
      if (/^\s*CREATE (?:TABLE|(?:UNIQUE )?INDEX)\s/.test(sql))
        await g.client.execute(
          sql.replaceAll('length(document)<=8192', 'length(document)<=16384'),
        );
  for (const f of sales) {
    const p = f.p,
      date = new Date().toISOString();
    await g.client.execute({
      sql: 'INSERT INTO imported_swap_preparations VALUES(?,?,?,?,?,?,?,?)',
      args: [
        p.preparationId,
        p.ownerId,
        p.projectId,
        1,
        p.wallet,
        1,
        p.preparationDocument,
        date,
      ],
    });
    await g.client.execute({
      sql: 'INSERT INTO imported_swap_signing_intents VALUES(?,?,?,?,?,?,?,?,?)',
      args: [
        p.intentId,
        p.ownerId,
        p.preparationId,
        p.wallet,
        p.approvalDocument,
        'finalized',
        p.signature,
        date,
        date,
      ],
    });
    await g.client.execute({
      sql: 'INSERT INTO imported_swap_receipts VALUES(?,?,?,?,?,?,?,?,?,?)',
      args: [
        p.receiptId,
        p.ownerId,
        p.intentId,
        p.preparationId,
        p.projectId,
        1,
        1,
        p.signature,
        p.receiptDocument,
        date,
      ],
    });
    await g.client.execute({
      sql: 'INSERT INTO solana_swap_signatures VALUES(?,?,?,?)',
      args: [p.ownerId, p.signature, 'imported', p.intentId],
    });
  }
  await migration('0115_imported_sale_receipt_evidence');
  await migration('0116_launch_sale_allocations');
  for (const f of sales)
    await retainOwnedImportedSaleEvidence(
      g.db,
      'alice',
      f.p.receiptId,
      signal(),
      f.rpc,
    );
  http.db = g.db;
}, 240000);
afterAll(() => {
  for (const c of clients) c.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const selection = () => [{ originId: origin, unitsRaw: '1000' }];
const consent = (sha: string) => ({
  approved: true as const,
  policy: LAUNCH_SALE_POLICY,
  planSha256: sha,
});
it('replays original launch and Token2022 sale proofs, saves once and recovers across workspaces without RPC', async () => {
  const beforeReads = g.reads.length,
    beforeSends = g.sends.length;
  const id = sales[0].p.receiptId;
  expect((await read(g.db, 'alice', id, signal())).plan).toBeNull();
  const first = await review(g.db, 'alice', id, selection(), signal());
  expect(first.allocations[0]).toMatchObject({
    beforeRaw: '0',
    afterRaw: '1000',
  });
  const saved = await record(
    g.db,
    'alice',
    id,
    selection(),
    consent(first.sha256),
    signal(),
  );
  expect(saved.plan).toEqual(first);
  expect(
    await record(
      g.db,
      'alice',
      id,
      selection(),
      consent(first.sha256),
      signal(),
    ),
  ).toEqual(saved);
  const second = await review(
    g.db,
    'alice',
    sales[1].p.receiptId,
    selection(),
    signal(),
  );
  expect(sales[1].p.projectId).not.toBe(sales[0].p.projectId);
  expect(second.allocations[0]).toMatchObject({
    beforeRaw: '1000',
    afterRaw: '2000',
  });
  await record(
    g.db,
    'alice',
    sales[1].p.receiptId,
    selection(),
    consent(second.sha256),
    signal(),
  );
  expect((await read(g.db, 'alice', id, signal())).plan).toEqual(first);
  expect(g.reads.length).toBe(beforeReads);
  expect(g.sends.length).toBe(beforeSends);
}, 120000);
it('requires exact approval and isolates account ownership', async () => {
  const id = sales[2].p.receiptId,
    p = await review(g.db, 'alice', id, selection(), signal());
  await expect(
    record(
      g.db,
      'alice',
      id,
      selection(),
      { ...consent(p.sha256), approved: false } as never,
      signal(),
    ),
  ).rejects.toThrow('Approve');
  await expect(
    record(g.db, 'alice', id, selection(), consent('a'.repeat(64)), signal()),
  ).rejects.toThrow('changed');
  await expect(read(g.db, 'bob', id, signal())).rejects.toThrow();
  await expect(
    review(
      g.db,
      'alice',
      id,
      [{ originId: 'a'.repeat(64), unitsRaw: '1000' }],
      signal(),
    ),
  ).rejects.toThrow('not found');
  await expect(
    review(g.db, 'alice', sales[4].p.receiptId, selection(), signal()),
  ).rejects.toThrow('approved with swap acquisitions');
  await g.client.execute({
    sql: 'INSERT INTO solana_execution_reservations VALUES(?,?,?,?,?)',
    args: ['alice', sales[2].p.wallet, 'imported', 'pending', 'signed'],
  });
  try {
    await expect(
      review(g.db, 'alice', id, selection(), signal()),
    ).rejects.toThrow('Recover or cancel');
    expect(
      (await read(g.db, 'alice', sales[0].p.receiptId, signal())).plan,
    ).not.toBeNull();
  } finally {
    await g.client.execute(
      "DELETE FROM solana_execution_reservations WHERE intent_id='pending'",
    );
  }
}, 120000);
it('returns replayed saved history when an insert response is lost without cancellation', async () => {
  const id = sales[2].p.receiptId,
    p = await review(g.db, 'alice', id, selection(), signal());
  const wrap = (
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(t, k) {
        if (k === 'bind')
          return (...args: unknown[]) => wrap(t.bind(...args), sql);
        if (
          k === 'run' &&
          sql.startsWith('INSERT INTO launch_sale_allocations')
        )
          return async () => {
            await t.run();
            throw Error('Lost response');
          };
        const v = Reflect.get(t, k);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  const db = {
    prepare: (sql: string) => wrap(g.db.prepare(sql), sql),
  } as D1Database;
  expect(
    (await record(db, 'alice', id, selection(), consent(p.sha256), signal()))
      .plan,
  ).toEqual(p);
}, 120000);
it('recovers a committed insert with a lost response and preserves history after cancellation', async () => {
  const id = sales[3].p.receiptId,
    p = await review(g.db, 'alice', id, selection(), signal());
  const c = new AbortController();
  let saved = false;
  const wrap = (
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(t, k) {
        if (k === 'bind')
          return (...args: unknown[]) => wrap(t.bind(...args), sql);
        if (
          k === 'run' &&
          sql.startsWith('INSERT INTO launch_sale_allocations')
        )
          return async () => {
            await t.run();
            saved = true;
            c.abort();
            throw Error('Lost response');
          };
        const v = Reflect.get(t, k);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  const db = {
    prepare: (sql: string) => wrap(g.db.prepare(sql), sql),
  } as D1Database;
  await expect(
    record(db, 'alice', id, selection(), consent(p.sha256), c.signal),
  ).rejects.toThrow();
  expect(saved).toBe(true);
  expect((await read(g.db, 'alice', id, signal())).plan).toEqual(p);
}, 120000);
it('runs signed-in HTTP review, exact approval, save and reload through real services and SQL without RPC', async () => {
  const id = sales[5].p.receiptId,
    url = 'https://bundle.example/api/account-launch-activity/sale-allocations',
    reads = g.reads.length,
    sends = g.sends.length,
    post = (body: unknown) =>
      postRoute(
        new Request(url, {
          method: 'POST',
          headers: {
            origin: 'https://bundle.example',
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
      ),
    load = async () => {
      const r = await getRoute(new Request(`${url}?saleReceiptId=${id}`));
      expect(r.status).toBe(200);
      return (await r.json()) as { plan: { sha256: string } | null };
    };
  expect((await load()).plan).toBeNull();
  const reviewed = await post({
    action: 'review',
    saleReceiptId: id,
    allocations: selection(),
  });
  expect(reviewed.status).toBe(200);
  const { plan } = (await reviewed.json()) as {
    plan: { sha256: string; executionAllowed: boolean };
  };
  expect(plan.executionAllowed).toBe(false);
  expect((await load()).plan).toBeNull();
  const approve = {
    action: 'record',
    saleReceiptId: id,
    allocations: selection(),
    approved: true,
    policy: LAUNCH_SALE_POLICY,
  };
  const wrong = await post({ ...approve, planSha256: 'f'.repeat(64) });
  expect(wrong.status).toBe(409);
  expect((await load()).plan).toBeNull();
  const saved = await post({ ...approve, planSha256: plan.sha256 });
  expect(saved.status).toBe(200);
  expect((await load()).plan?.sha256).toBe(plan.sha256);
  const again = await post({ ...approve, planSha256: plan.sha256 });
  expect(
    ((await again.json()) as typeof plan & { plan: { sha256: string } }).plan
      .sha256,
  ).toBe(plan.sha256);
  expect([g.reads.length, g.sends.length]).toEqual([reads, sends]);
}, 120000);
it('refuses missing guards and self-rehashed corrupt saved allocations', async () => {
  const id = sales[0].p.receiptId;
  const guard = readFileSync('drizzle/0116_launch_sale_allocations.sql', 'utf8')
    .split('--> statement-breakpoint')
    .find((s) =>
      s.includes('CREATE TRIGGER launch_sale_allocations_no_update'),
    )!;
  await g.client.execute('DROP TRIGGER launch_sale_allocations_no_update');
  await expect(read(g.db, 'alice', id, signal())).rejects.toThrow(
    'not installed',
  );
  const row = (
    await g.client.execute({
      sql: 'SELECT document FROM launch_sale_allocations WHERE sale_receipt_id=?',
      args: [id],
    })
  ).rows[0];
  if (typeof row.document !== 'string')
    throw Error('Expected a retained JSON document');
  const doc = JSON.parse(row.document);
  doc.allocations[0].unitsRaw = '999';
  doc.allocations[0].afterRaw = '999';
  const { sha256: _, ...core } = doc;
  doc.sha256 = await pumpHolderDigest(core);
  await g.client.execute({
    sql: 'UPDATE launch_sale_allocations SET document=?,sha256=? WHERE sale_receipt_id=?',
    args: [canonical(doc), doc.sha256, id],
  });
  await g.client.execute(guard);
  await expect(read(g.db, 'alice', id, signal())).rejects.toThrow(
    'complete sale',
  );
}, 120000);
