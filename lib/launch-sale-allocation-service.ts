import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import { UUID } from './wallet-operation';
import { readOwnedImportedSaleSource } from './imported-sale-evidence-service';
import { readOwnedPumpPurchaseAcquisitionSource } from './pump-purchase-cost-service';
import {
  LAUNCH_SALE_POLICY,
  LaunchSaleAllocationError,
  planLaunchSaleAllocation,
  type LaunchSaleAllocation,
} from './launch-sale-allocation';
const fail = (message: string, status = 409): never => {
  throw new LaunchSaleAllocationError(message, status);
};
type Row = {
  owner_id: string;
  sale_receipt_id: string;
  sale_signature: string;
  wallet: string;
  mint: string;
  document: string;
  sha256: string;
  created_at: string;
};
export type LaunchSaleSelection = { originId: string; unitsRaw: string };
async function guards(db: D1Database) {
  const r = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('launch_sale_allocations_insert','launch_sale_allocations_no_update','launch_sale_allocations_no_delete','launch_sale_legacy_insert','launch_sale_legacy_update')",
    )
    .first<{ n: number }>();
  if (r?.n !== 5) fail('Launch sale accounting storage is not installed.');
}
async function rows(
  db: D1Database,
  owner: string,
  wallet: string,
  mint: string,
) {
  const r = await db
    .prepare(
      'SELECT * FROM launch_sale_allocations WHERE owner_id=? AND wallet=? AND mint=? ORDER BY sale_receipt_id LIMIT 4001',
    )
    .bind(owner, wallet, mint)
    .all<Row>();
  if (r.results.length > 4000)
    fail('Complete launch sale history exceeds the supported limit.');
  return r.results;
}
function selections(value: LaunchSaleSelection[]) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 8 ||
    new Set(value.map((v) => v?.originId)).size !== value.length ||
    value.some(
      (v) =>
        !v ||
        Object.keys(v).sort().join(',') !== 'originId,unitsRaw' ||
        !/^[a-f0-9]{64}$/.test(v.originId) ||
        !/^([1-9]\d{0,19})$/.test(v.unitsRaw) ||
        BigInt(v.unitsRaw) > 18446744073709551615n,
    )
  )
    fail(
      'Select one to eight distinct recorded buys and exact positive units.',
    );
  return structuredClone(value);
}
async function idle(db: D1Database, owner: string, wallet: string) {
  const busy = await db
    .prepare(
      'SELECT 1 AS found FROM solana_execution_reservations WHERE owner_id=? AND wallet_address=? UNION ALL SELECT 1 AS found FROM solana_swap_reservations WHERE owner_id=? AND wallet_address=? LIMIT 1',
    )
    .bind(owner, wallet, owner, wallet)
    .first();
  if (busy)
    fail(
      'Recover or cancel the active wallet approval before assigning acquisition accounting.',
    );
}
async function context(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!UUID.test(id)) fail('Select one retained sale.');
  await guards(db);
  const sale = await readOwnedImportedSaleSource(db, owner, id, signal);
  if (
    Object.hasOwn(
      JSON.parse(sale.parent.approvalDocument) as object,
      'acquisition',
    )
  )
    fail(
      'This sale was approved with swap acquisitions. Recover its existing acquisition history.',
    );
  const before = await rows(
    db,
    owner,
    sale.evidence.report.wallet,
    sale.evidence.report.mint,
  );
  const sources = new Map<
    string,
    Awaited<ReturnType<typeof readOwnedPumpPurchaseAcquisitionSource>>
  >();
  const getSource = async (origin: string) => {
    let value = sources.get(origin);
    if (!value) {
      value = await readOwnedPumpPurchaseAcquisitionSource(
        db,
        owner,
        origin,
        signal,
      );
      sources.set(origin, value);
    }
    return value;
  };
  const sales = new Map([[id, sale]]),
    plans: LaunchSaleAllocation[] = [];
  for (const row of before) {
    signal.throwIfAborted();
    const doc = JSON.parse(row.document) as LaunchSaleAllocation;
    if (
      row.owner_id !== owner ||
      !UUID.test(row.sale_receipt_id) ||
      doc.saleReceiptId !== row.sale_receipt_id ||
      doc.saleSignature !== row.sale_signature ||
      doc.wallet !== row.wallet ||
      doc.mint !== row.mint ||
      doc.sha256 !== row.sha256 ||
      !Number.isFinite(Date.parse(row.created_at)) ||
      !Array.isArray(doc.allocations) ||
      doc.allocations.length < 1 ||
      doc.allocations.length > 8
    )
      fail('Saved launch sale history differs.');
    let original = sales.get(row.sale_receipt_id);
    if (!original) {
      original = await readOwnedImportedSaleSource(
        db,
        owner,
        row.sale_receipt_id,
        signal,
      );
      sales.set(row.sale_receipt_id, original);
    }
    if (
      Object.hasOwn(
        JSON.parse(original.parent.approvalDocument) as object,
        'acquisition',
      )
    )
      fail(
        'Saved launch accounting conflicts with approved swap acquisitions.',
      );
    const inputs = [];
    for (const a of doc.allocations) {
      const s = await getSource(a.originId);
      inputs.push({
        source: s.source,
        receiptSha256: s.receiptSha256,
        buySlot: s.slot,
        beforeRaw: a.beforeRaw,
        unitsRaw: a.unitsRaw,
      });
    }
    if (
      canonical(
        await planLaunchSaleAllocation(original.evidence, inputs, signal),
      ) !== canonical(doc)
    )
      fail('Saved launch sale evidence or allocation differs.');
    const old = await db
      .prepare(
        'SELECT 1 AS found FROM imported_trade_lot_links WHERE owner_id=? AND (sell_receipt_id=? OR sell_signature=?) LIMIT 1',
      )
      .bind(owner, row.sale_receipt_id, row.sale_signature)
      .first();
    if (old) fail('A sale appears in both acquisition ledgers.');
    plans.push(doc);
  }
  const intervals = new Map<string, LaunchSaleAllocation['allocations']>();
  for (const plan of plans)
    for (const a of plan.allocations) {
      const list = intervals.get(a.originId) ?? [];
      list.push(a);
      intervals.set(a.originId, list);
    }
  const consumed = new Map<string, string>();
  for (const [origin, list] of intervals) {
    list.sort((a, b) => (BigInt(a.beforeRaw) < BigInt(b.beforeRaw) ? -1 : 1));
    let end = '0';
    for (const a of list) {
      if (a.beforeRaw !== end)
        fail('Launch acquisition history is incomplete or overlaps.');
      end = a.afterRaw;
    }
    consumed.set(origin, end);
  }
  const stable = async () => {
    if (
      canonical(
        await rows(
          db,
          owner,
          sale.evidence.report.wallet,
          sale.evidence.report.mint,
        ),
      ) !== canonical(before)
    )
      fail('Launch sale accounting changed. Reload the review.');
    signal.throwIfAborted();
  };
  return { sale, before, plans, consumed, getSource, stable };
}
/** Saved-only verification, without RPC. Packet evidence remains internal. */
export async function readOwnedLaunchSaleAllocation(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  const c = await context(db, owner, id, signal);
  const plan = c.plans.find((p) => p.saleReceiptId === id) ?? null;
  await c.stable();
  return {
    saleReceiptId: id,
    plan,
    executionAllowed: false as const,
    profitCalculated: false as const,
  };
}
/** Preview uses remaining units across the owner's complete wallet/mint history,
 * including other imported workspaces. No reservation or transaction change. */
export async function reviewOwnedLaunchSaleAllocation(
  db: D1Database,
  owner: string,
  id: string,
  supplied: LaunchSaleSelection[],
  signal: AbortSignal,
) {
  const selected = selections(supplied),
    c = await context(db, owner, id, signal);
  if (c.plans.some((p) => p.saleReceiptId === id))
    fail('This sale already has saved launch acquisitions. Load its history.');
  const old = await db
    .prepare(
      'SELECT 1 AS found FROM imported_trade_lot_links WHERE owner_id=? AND (sell_receipt_id=? OR sell_signature=?) LIMIT 1',
    )
    .bind(owner, id, c.sale.evidence.report.signature)
    .first();
  if (old) fail('This sale already has swap acquisition links.');
  await idle(db, owner, c.sale.evidence.report.wallet);
  const inputs = [];
  for (const a of selected) {
    const s = await c.getSource(a.originId);
    inputs.push({
      source: s.source,
      receiptSha256: s.receiptSha256,
      buySlot: s.slot,
      beforeRaw: c.consumed.get(a.originId) ?? '0',
      unitsRaw: a.unitsRaw,
    });
  }
  const plan = await planLaunchSaleAllocation(c.sale.evidence, inputs, signal);
  await c.stable();
  return plan;
}
/** Explicit immutable bookkeeping write. Compare-and-insert SQL checks all
 * original sources and current intervals in one atomic statement. */
export async function recordOwnedLaunchSaleAllocation(
  db: D1Database,
  owner: string,
  id: string,
  supplied: LaunchSaleSelection[],
  consent: {
    approved: true;
    policy: typeof LAUNCH_SALE_POLICY;
    planSha256: string;
  },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (
    !consent ||
    Object.keys(consent).sort().join(',') !== 'approved,planSha256,policy' ||
    consent.approved !== true ||
    consent.policy !== LAUNCH_SALE_POLICY ||
    !/^[a-f0-9]{64}$/.test(consent.planSha256)
  )
    fail('Approve the exact reviewed launch acquisition plan.');
  const selected = selections(supplied),
    saved = await readOwnedLaunchSaleAllocation(db, owner, id, signal);
  if (saved.plan) {
    if (
      saved.plan.sha256 !== consent.planSha256 ||
      canonical(
        saved.plan.allocations.map((a) => ({
          originId: a.originId,
          unitsRaw: a.unitsRaw,
        })),
      ) !==
        canonical(selected.sort((a, b) => a.originId.localeCompare(b.originId)))
    )
      fail('Saved sale allocation differs from this approval.');
    return saved;
  }
  const plan = await reviewOwnedLaunchSaleAllocation(
    db,
    owner,
    id,
    selected,
    signal,
  );
  if (plan.sha256 !== consent.planSha256)
    fail('Remaining acquisition units changed. Review the sale again.');
  signal.throwIfAborted();
  try {
    await db
      .prepare(
        'INSERT INTO launch_sale_allocations(owner_id,sale_receipt_id,sale_signature,wallet,mint,document,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        owner,
        id,
        plan.saleSignature,
        plan.wallet,
        plan.mint,
        canonical(plan),
        plan.sha256,
        new Date().toISOString(),
      )
      .run();
  } catch {
    const recovered = await readOwnedLaunchSaleAllocation(
      db,
      owner,
      id,
      signal,
    );
    if (recovered.plan?.sha256 !== plan.sha256)
      fail(
        'The sale or remaining acquisitions changed before saving. Reload saved history.',
      );
    return recovered;
  }
  return readOwnedLaunchSaleAllocation(db, owner, id, signal);
}
