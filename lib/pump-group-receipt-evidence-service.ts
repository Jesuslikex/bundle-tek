import { PumpPreflightError } from './owned-pump-preflight';
import { canonicalPumpHolderJson } from './pump-holder-review';
import {
  collectPumpGroupReceiptEvidence,
  parsePumpGroupReceiptEvidence,
  type PumpGroupReceiptEvidence,
} from './pump-group-receipt-evidence';
import {
  launchEvidenceId,
  type AccountLaunchEvidence,
} from './account-launch-evidence';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import type { PumpLaunchGroupReview } from './pump-launch-group-review';
import type { verifyPumpLaunchGroupSignatures } from './pump-launch-group-signatures';
import { projectVerifiedPumpGroupPayments } from './pump-group-payments';

type Parent = {
  review: string;
  signed: string;
  signature: string;
  state: string;
};
type Row = {
  id: string;
  owner_id: string;
  review_id: string;
  context_sha256: string;
  signed_group_sha256: string;
  sha256: string;
  evidence: string;
  created_at: string;
};
const fail = (message: string, status = 409): never => {
  throw new PumpPreflightError(message, status);
};
async function parent(db: D1Database, owner: string, id: string) {
  if (!launchEvidenceId(id)) return fail('Select one saved launch group.', 400);
  const p = await db
    .prepare(
      "SELECT r.review,r.signed,r.signature,r.state FROM pump_launch_reviews r JOIN pump_group_signatures s ON s.review_id=r.id AND s.owner_id=r.owner_id AND s.signed=r.signed AND s.signature=r.signature WHERE r.owner_id=? AND r.id=? AND json_extract(r.review,'$.format')='pump-launch-group-review-v1' AND s.context_sha256=json_extract(r.review,'$.contextSha256') AND s.manifest_sha256=json_extract(r.review,'$.manifestSha256') AND s.signed_group_sha256=json_extract(r.signed,'$.signedGroupSha256')",
    )
    .bind(owner, id)
    .first<Parent>();
  if (!p)
    return fail(
      'Saved signed launch group not found. Retain the complete signed group in its launch history first.',
      404,
    );
  return {
    row: p,
    group: {
      review: JSON.parse(p.review) as PumpLaunchGroupReview,
      signedEvidence: JSON.parse(p.signed) as Awaited<
        ReturnType<typeof verifyPumpLaunchGroupSignatures>
      >,
    },
  };
}
async function guards(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('pump_group_receipt_evidence_insert','pump_group_receipt_evidence_no_update','pump_group_receipt_evidence_no_delete')",
    )
    .first<{ n: number }>();
  if (row?.n !== 3)
    fail(
      'Launch receipt history storage is not installed. Saving remains unavailable.',
      503,
    );
}
function summary(
  id: string,
  evidence: PumpGroupReceiptEvidence,
): AccountLaunchEvidence {
  const r = evidence.report;
  return {
    reviewId: r.reviewId,
    mint: r.mint,
    entry: {
      id,
      sha256: evidence.sha256,
      observedAt: r.observedAt,
      packetCount: r.packets.length,
      successfulPackets: r.packets.filter((p) => p.outcome === 'success')
        .length,
      failedPackets: r.packets.filter((p) => p.outcome === 'failed').length,
      missingPackets: r.packets.filter((p) => p.outcome === 'not-observed')
        .length,
      instructionMetadataPackets: evidence.receipts.filter(
        (r) =>
          r &&
          typeof r.meta === 'object' &&
          r.meta !== null &&
          Array.isArray((r.meta as Record<string, unknown>).innerInstructions),
      ).length,
      balanceCoverageComplete: r.complete,
      acquisitionBasisVerified: false,
      executionAllowed: false,
    },
  };
}
async function parsedSource(
  row: Row,
  owner: string,
  id: string,
  p: Awaited<ReturnType<typeof parent>>,
  signal: AbortSignal,
) {
  if (
    row.owner_id !== owner ||
    row.review_id !== id ||
    row.context_sha256 !== p.group.review.contextSha256 ||
    row.signed_group_sha256 !== p.group.signedEvidence.signedGroupSha256
  )
    return fail('Saved launch receipt row differs.');
  const e = await parsePumpGroupReceiptEvidence(
    JSON.parse(row.evidence),
    p.group,
    signal,
  );
  if (row.sha256 !== e.sha256 || row.created_at !== e.report.observedAt)
    return fail('Saved launch receipt row differs.');
  const payments = await projectVerifiedPumpGroupPayments(e, p.group, signal);
  return { evidence: e, payments };
}
async function convert(
  row: Row,
  owner: string,
  id: string,
  p: Awaited<ReturnType<typeof parent>>,
  signal: AbortSignal,
) {
  const source = await parsedSource(row, owner, id, p, signal),
    value = summary(row.id, source.evidence);
  value.entry!.payments = source.payments;
  return value;
}
async function existing(db: D1Database, owner: string, requestId: string) {
  return db
    .prepare(
      'SELECT * FROM pump_group_receipt_evidence WHERE owner_id=? AND id=?',
    )
    .bind(owner, requestId)
    .first<Row>();
}
async function stable(
  db: D1Database,
  owner: string,
  id: string,
  p: Awaited<ReturnType<typeof parent>>,
  value: AccountLaunchEvidence,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const after = await parent(db, owner, id);
  signal.throwIfAborted();
  if (canonicalPumpHolderJson(p.row) !== canonicalPumpHolderJson(after.row))
    return fail(
      'Saved launch group changed while checking receipt evidence. Reload its history.',
    );
  return value;
}
/** Retained-only reload. No RPC, mutation, approval or reservation changes. */
export async function readOwnedPumpGroupReceiptEvidence(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
): Promise<AccountLaunchEvidence> {
  signal.throwIfAborted();
  await guards(db);
  const p = await parent(db, owner, id);
  const row = await db
    .prepare(
      'SELECT * FROM pump_group_receipt_evidence WHERE owner_id=? AND review_id=? ORDER BY created_at DESC,id DESC LIMIT 1',
    )
    .bind(owner, id)
    .first<Row>();
  signal.throwIfAborted();
  const value = row
    ? await convert(row, owner, id, p, signal)
    : { reviewId: id, mint: p.group.review.input.create.mint, entry: null };
  return stable(db, owner, id, p, value, signal);
}
/** Private exact-source read for durable accounting. Never serialize this result
 * into an HTTP response: it contains the retained signed packet evidence.
 * Unlike the public latest-summary read, a poorer new snapshot cannot select or
 * replace a previously reviewed source. No provider access or mutation. */
export async function readOwnedPumpGroupReceiptSource(
  db: D1Database,
  owner: string,
  reviewId: string,
  receiptId: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!launchEvidenceId(receiptId))
    return fail('Select one retained launch receipt.', 400);
  await guards(db);
  const p = await parent(db, owner, reviewId),
    row = await existing(db, owner, receiptId);
  if (!row || row.review_id !== reviewId)
    return fail('The selected launch receipt was not found.', 404);
  const source = await parsedSource(row, owner, reviewId, p, signal);
  const after = await existing(db, owner, receiptId);
  signal.throwIfAborted();
  if (canonicalPumpHolderJson(row) !== canonicalPumpHolderJson(after))
    return fail(
      'The selected launch receipt changed while checking its costs.',
    );
  await stable(
    db,
    owner,
    reviewId,
    p,
    summary(row.id, source.evidence),
    signal,
  );
  return { row, parent: p.row, group: p.group, ...source };
}
/** Explicit evidence capture; the request carries identity only, never caller-authored receipts. */
export async function retainOwnedPumpGroupReceiptEvidence(
  db: D1Database,
  owner: string,
  id: string,
  requestId: string,
  signal: AbortSignal,
  rpc: PumpLaunchRpc,
): Promise<AccountLaunchEvidence> {
  signal.throwIfAborted();
  if (!launchEvidenceId(requestId))
    return fail('A receipt request identity is required.', 400);
  await guards(db);
  const p = await parent(db, owner, id),
    saved = await existing(db, owner, requestId);
  if (saved)
    return stable(
      db,
      owner,
      id,
      p,
      await convert(saved, owner, id, p, signal),
      signal,
    );
  const capacity = await db
    .prepare(
      'SELECT count(*) AS total,sum(CASE WHEN review_id=? THEN 1 ELSE 0 END) AS group_count FROM pump_group_receipt_evidence WHERE owner_id=?',
    )
    .bind(id, owner)
    .first<{ total: number; group_count: number | null }>();
  if (!capacity || capacity.total >= 128 || (capacity.group_count ?? 0) >= 8)
    return fail(
      'Launch receipt history capacity reached. Existing saved evidence remains available.',
      409,
    );
  signal.throwIfAborted();
  const now = Date.now();
  const gate = await db
    .prepare(
      'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
    )
    .bind(
      JSON.stringify(['pump-receipt-evidence-v1', owner, id]),
      now + 5000,
      now,
    )
    .run();
  if (!gate.meta.changes)
    return fail(
      'Wait 5 seconds before collecting another receipt snapshot. Saved history remains available.',
      429,
    );
  const evidence = await collectPumpGroupReceiptEvidence(p.group, signal, rpc);
  signal.throwIfAborted();
  const current = await parent(db, owner, id);
  if (canonicalPumpHolderJson(p.row) !== canonicalPumpHolderJson(current.row))
    return fail(
      'Launch group changed while collecting receipt history. Reload it.',
    );
  try {
    await db
      .prepare(
        'INSERT INTO pump_group_receipt_evidence(id,owner_id,review_id,context_sha256,signed_group_sha256,sha256,evidence,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM pump_launch_reviews WHERE owner_id=? AND id=? AND review=? AND signed=? AND signature=? AND state=?)',
      )
      .bind(
        requestId,
        owner,
        id,
        p.group.review.contextSha256,
        p.group.signedEvidence.signedGroupSha256,
        evidence.sha256,
        canonicalPumpHolderJson(evidence),
        evidence.report.observedAt,
        owner,
        id,
        p.row.review,
        p.row.signed,
        p.row.signature,
        p.row.state,
      )
      .run();
  } catch {
    // A lost response or simultaneous same-identity retry recovers the exact
    // immutable original. Never replace it with the newer provider response.
    const retained = await existing(db, owner, requestId);
    if (retained)
      return stable(
        db,
        owner,
        id,
        p,
        await convert(retained, owner, id, p, signal),
        signal,
      );
    return fail(
      'Receipt history was not confirmed saved. Retry the same request or load saved history; source changes and capacity limits can refuse a save.',
    );
  }
  signal.throwIfAborted();
  const retained = await existing(db, owner, requestId);
  if (!retained)
    return fail('Launch source changed before receipt history could be saved.');
  return stable(
    db,
    owner,
    id,
    p,
    await convert(retained, owner, id, p, signal),
    signal,
  );
}
