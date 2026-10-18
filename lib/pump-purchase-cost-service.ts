import { PumpPreflightError } from './owned-pump-preflight';
import { launchEvidenceId } from './account-launch-evidence';
import { canonicalPumpHolderJson } from './pump-holder-review';
import { readOwnedPumpGroupReceiptSource } from './pump-group-receipt-evidence-service';
import { readOwnedPumpGroupRecordedCosts } from './pump-group-recorded-costs-service';
import {
  allocatePumpPurchaseCosts,
  PUMP_PURCHASE_COST_POLICY,
  type PumpPurchaseCostPlan,
  type PumpPurchaseCostSource,
} from './pump-purchase-costs';

type Parent = {
  review: string;
  signed: string;
  signature: string;
  state: string;
  receipt: string;
};
type Batch = {
  owner_id: string;
  receipt_id: string;
  review_id: string;
  parent: string;
  costs: string;
  plan: string;
  sha256: string;
  created_at: string;
};
type Source = {
  owner_id: string;
  origin_id: string;
  receipt_id: string;
  review_id: string;
  mint: string;
  wallet: string;
  source: string;
  sha256: string;
};
type TerminalProof = {
  parent: string;
  costs: Awaited<ReturnType<typeof readOwnedPumpGroupRecordedCosts>>;
};
const fail = (message: string, status = 409): never => {
  throw new PumpPreflightError(message, status);
};
const canonical = canonicalPumpHolderJson;
async function guards(db: D1Database) {
  const found = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('pump_purchase_cost_batches_insert','pump_purchase_cost_batches_no_update','pump_purchase_cost_batches_no_delete','pump_purchase_cost_sources_insert','pump_purchase_cost_sources_no_update','pump_purchase_cost_sources_no_delete')",
    )
    .first<{ n: number }>();
  if (found?.n !== 6)
    return fail(
      'Launch buy cost storage is not installed. Existing receipt history remains available.',
      503,
    );
}
async function parent(db: D1Database, owner: string, reviewId: string) {
  const row = await db
    .prepare(
      'SELECT review,signed,signature,state,receipt FROM pump_launch_reviews WHERE owner_id=? AND id=?',
    )
    .bind(owner, reviewId)
    .first<Parent>();
  if (!row || typeof row.receipt !== 'string' || !row.signed || !row.signature)
    return fail('A closed owned signed launch group is required.', 404);
  return row;
}
async function context(
  db: D1Database,
  owner: string,
  reviewId: string,
  receiptId: string,
  signal: AbortSignal,
  proof?: TerminalProof,
) {
  signal.throwIfAborted();
  if (!launchEvidenceId(reviewId) || !launchEvidenceId(receiptId))
    return fail('Select a saved launch and receipt.', 400);
  await guards(db);
  const before = await parent(db, owner, reviewId);
  if (proof && proof.parent !== canonical(before))
    return fail(
      'The launch changed after its retained terminal proof was checked.',
    );
  const selected = await readOwnedPumpGroupReceiptSource(
      db,
      owner,
      reviewId,
      receiptId,
      signal,
    ),
    costs =
      proof?.costs ??
      (await readOwnedPumpGroupRecordedCosts(db, owner, reviewId, signal)),
    plan = await allocatePumpPurchaseCosts(
      selected.evidence,
      selected.group,
      costs,
      signal,
    ),
    after = await parent(db, owner, reviewId);
  signal.throwIfAborted();
  if (
    canonical(before) !== canonical(after) ||
    selected.parent.review !== before.review ||
    selected.parent.signed !== before.signed ||
    selected.parent.signature !== before.signature ||
    selected.parent.state !== before.state
  )
    return fail(
      'The launch changed while allocating costs. Reload its saved history.',
    );
  return {
    parent: canonical(before),
    costs: canonical(costs),
    plan,
    receiptId,
    reviewId,
  };
}
async function batch(db: D1Database, owner: string, receiptId: string) {
  return db
    .prepare(
      'SELECT * FROM pump_purchase_cost_batches WHERE owner_id=? AND receipt_id=?',
    )
    .bind(owner, receiptId)
    .first<Batch>();
}
function validateBatch(
  row: Batch,
  owner: string,
  current: Awaited<ReturnType<typeof context>>,
) {
  if (
    row.owner_id !== owner ||
    row.receipt_id !== current.receiptId ||
    row.review_id !== current.reviewId ||
    row.parent !== current.parent ||
    row.costs !== current.costs ||
    row.plan !== canonical(current.plan) ||
    row.sha256 !== current.plan.sha256 ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    new Date(row.created_at).toISOString() !== row.created_at
  )
    return fail(
      'The saved launch buy cost batch differs from its exact retained proofs.',
    );
}
function validateSource(
  row: Source,
  owner: string,
  expected: PumpPurchaseCostSource,
) {
  if (
    row.owner_id !== owner ||
    row.review_id !== expected.reviewId ||
    row.origin_id !== expected.originId ||
    row.mint !== expected.mint ||
    row.wallet !== expected.wallet ||
    row.sha256 !== expected.sha256 ||
    row.source !== canonical(expected)
  )
    return fail(
      'A launch buy origin already has different recorded costs. Existing costs were preserved.',
    );
}
async function origin(db: D1Database, owner: string, originId: string) {
  return db
    .prepare(
      'SELECT * FROM pump_purchase_cost_sources WHERE owner_id=? AND origin_id=?',
    )
    .bind(owner, originId)
    .first<Source>();
}
/** Explicit database-only preview. No caller-authored cost input and no RPC. */
export async function readOwnedPumpPurchaseCostPlan(
  db: D1Database,
  owner: string,
  reviewId: string,
  receiptId: string,
  signal: AbortSignal,
) {
  const current = await context(db, owner, reviewId, receiptId, signal),
    saved = await batch(db, owner, receiptId);
  if (saved) validateBatch(saved, owner, current);
  const originalPlans = new Map<string, PumpPurchaseCostPlan>();
  if (saved) originalPlans.set(receiptId, current.plan);
  const recordedOriginIds: string[] = [];
  for (const source of current.plan.sources) {
    signal.throwIfAborted();
    const existing = await origin(db, owner, source.originId);
    if (existing) {
      validateSource(existing, owner, source);
      if (!originalPlans.has(existing.receipt_id)) {
        if (originalPlans.size >= 8)
          return fail('Saved launch receipt capacity differs.');
        const original = await context(
            db,
            owner,
            reviewId,
            existing.receipt_id,
            signal,
            {
              parent: current.parent,
              costs: JSON.parse(current.costs) as TerminalProof['costs'],
            },
          ),
          originalBatch = await batch(db, owner, existing.receipt_id);
        if (!originalBatch)
          return fail('The original launch buy cost batch is missing.');
        validateBatch(originalBatch, owner, original);
        originalPlans.set(existing.receipt_id, original.plan);
      }
      const originalSource = originalPlans
        .get(existing.receipt_id)!
        .sources.find((s) => s.originId === existing.origin_id);
      if (!originalSource)
        return fail('The original launch buy cost source is missing.');
      validateSource(existing, owner, originalSource);
      recordedOriginIds.push(source.originId);
    } else if (saved)
      return fail('A saved launch buy cost batch has missing source records.');
  }
  if (canonical(await parent(db, owner, reviewId)) !== current.parent)
    return fail('The launch changed while reading recorded buy costs.');
  signal.throwIfAborted();
  return {
    reviewId,
    receiptId,
    plan: current.plan,
    recordedOriginIds,
    saved: saved !== null,
  };
}
export type PumpPurchaseCostConsent = {
  receiptId: string;
  planSha256: string;
  policy: typeof PUMP_PURCHASE_COST_POLICY;
  approved: true;
};
/** Natural idempotency: one immutable batch per exact retained receipt and one
 * global owner/origin source. Atomic insert-only writes; never a trading action. */
export async function recordOwnedPumpPurchaseCosts(
  db: D1Database,
  owner: string,
  reviewId: string,
  supplied: PumpPurchaseCostConsent,
  signal: AbortSignal,
) {
  const consent = structuredClone(supplied);
  if (
    !consent ||
    Object.keys(consent).sort().join(',') !==
      'approved,planSha256,policy,receiptId' ||
    consent.approved !== true ||
    consent.policy !== PUMP_PURCHASE_COST_POLICY ||
    !/^[a-f0-9]{64}$/.test(consent.planSha256)
  )
    return fail(
      'Explicit approval of the exact buy cost policy and plan is required.',
      400,
    );
  const current = await context(db, owner, reviewId, consent.receiptId, signal);
  if (current.plan.sha256 !== consent.planSha256)
    return fail(
      'The buy cost plan changed. Review its exact saved receipt again.',
    );
  if (!current.plan.sources.length)
    return fail(
      'No verified purchases are available to record. Saved receipt history remains available.',
    );
  const saved = await batch(db, owner, consent.receiptId);
  if (saved) {
    validateBatch(saved, owner, current);
    return readOwnedPumpPurchaseCostPlan(
      db,
      owner,
      reviewId,
      consent.receiptId,
      signal,
    );
  }
  const statements = [
    db
      .prepare(
        'INSERT OR IGNORE INTO pump_purchase_cost_batches(owner_id,receipt_id,review_id,parent,costs,plan,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        owner,
        consent.receiptId,
        reviewId,
        current.parent,
        current.costs,
        canonical(current.plan),
        current.plan.sha256,
        new Date().toISOString(),
      ),
  ];
  for (const source of current.plan.sources)
    statements.push(
      db
        .prepare(
          'INSERT OR IGNORE INTO pump_purchase_cost_sources(owner_id,origin_id,receipt_id,review_id,mint,wallet,source,sha256) VALUES(?,?,?,?,?,?,?,?)',
        )
        .bind(
          owner,
          source.originId,
          consent.receiptId,
          reviewId,
          source.mint,
          source.wallet,
          canonical(source),
          source.sha256,
        ),
    );
  signal.throwIfAborted();
  try {
    await db.batch(statements);
  } catch {
    // Includes an ambiguous committed response and simultaneous identical saves.
    // Only a complete independently replayed immutable batch can recover success.
    const raced = await batch(db, owner, consent.receiptId);
    if (!raced)
      return fail(
        'Buy cost records could not be saved. Reload saved costs before retrying; existing records were preserved.',
      );
    validateBatch(raced, owner, current);
  }
  signal.throwIfAborted();
  return readOwnedPumpPurchaseCostPlan(
    db,
    owner,
    reviewId,
    consent.receiptId,
    signal,
  );
}

/** Saved-only history replays each original receipt/broadcast proof, never the
 * latest primary snapshot. Distinct source origins are returned once. */
export async function readOwnedPumpPurchaseCostHistory(
  db: D1Database,
  owner: string,
  reviewId: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!launchEvidenceId(reviewId)) return fail('Select one saved launch.', 400);
  await guards(db);
  const before = canonical(await parent(db, owner, reviewId));
  // One exact closed-parent proof per request. Each primary receipt still uses
  // its original parser, and every context rechecks this same parent binding.
  const proof = {
    parent: before,
    costs: await readOwnedPumpGroupRecordedCosts(db, owner, reviewId, signal),
  };
  const batches = await db
    .prepare(
      'SELECT * FROM pump_purchase_cost_batches WHERE owner_id=? AND review_id=? ORDER BY receipt_id LIMIT 9',
    )
    .bind(owner, reviewId)
    .all<Batch>();
  if (batches.results.length > 8)
    return fail('Saved launch receipt capacity differs.');
  const replayed = new Map<string, PumpPurchaseCostPlan>(),
    expectedSources = new Map<string, PumpPurchaseCostSource>();
  for (const saved of batches.results) {
    const current = await context(
      db,
      owner,
      reviewId,
      saved.receipt_id,
      signal,
      proof,
    );
    validateBatch(saved, owner, current);
    replayed.set(saved.receipt_id, current.plan);
    for (const source of current.plan.sources) {
      const prior = expectedSources.get(source.originId);
      if (prior && canonical(prior) !== canonical(source))
        return fail(
          'Saved launch buy batches disagree about an acquisition origin.',
        );
      expectedSources.set(source.originId, source);
    }
  }
  const rows = await db
    .prepare(
      'SELECT * FROM pump_purchase_cost_sources WHERE owner_id=? AND review_id=? ORDER BY origin_id LIMIT 202',
    )
    .bind(owner, reviewId)
    .all<Source>();
  if (rows.results.length > 201 || rows.results.length !== expectedSources.size)
    return fail('Saved launch buy cost capacity differs.');
  const sources: PumpPurchaseCostSource[] = [];
  for (const row of rows.results) {
    signal.throwIfAborted();
    const expected = replayed
      .get(row.receipt_id)
      ?.sources.find((s) => s.originId === row.origin_id);
    if (!expected)
      return fail('The original launch buy cost source is missing.');
    validateSource(row, owner, expected);
    sources.push(expected);
  }
  if (canonical(await parent(db, owner, reviewId)) !== before)
    return fail('The launch changed while reading saved buy cost history.');
  signal.throwIfAborted();
  return {
    reviewId,
    sources,
    acquisitionBasisVerified: false as const,
    profitCalculated: false as const,
    executionAllowed: false as const,
  };
}
