import { UUID } from './wallet-operation';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import {
  collectImportedSaleEvidence,
  parseImportedSaleEvidence,
  requireImportedSaleParent,
  type ImportedSaleParent,
  type ImportedSaleEvidence,
  type ImportedSaleEvidenceRpc,
} from './imported-sale-evidence';
export class ImportedSaleEvidenceError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
const fail = (message: string, status = 409): never => {
  throw new ImportedSaleEvidenceError(message, status);
};
type Row = {
  owner_id: string;
  receipt_id: string;
  signature: string;
  parent: string;
  parent_sha256: string;
  evidence: string;
  sha256: string;
  created_at: string;
};
const names = [
  'imported_sale_evidence_insert',
  'imported_sale_evidence_no_update',
  'imported_sale_evidence_no_delete',
  'imported_sale_parent_receipt_update',
  'imported_sale_parent_receipt_delete',
  'imported_sale_parent_preparation_update',
  'imported_sale_parent_preparation_delete',
  'imported_sale_parent_approval_update',
  'imported_sale_parent_approval_delete',
  'imported_sale_parent_signature_update',
  'imported_sale_parent_signature_delete',
];
async function guards(db: D1Database) {
  const count = await db
    .prepare(
      `SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN (${names.map(() => '?').join(',')})`,
    )
    .bind(...names)
    .first<{ n: number }>();
  if (count?.n !== names.length)
    return fail(
      'Retained sale evidence storage is not installed. Existing sale summaries remain available.',
      503,
    );
}
async function parent(db: D1Database, owner: string, id: string) {
  if (typeof id !== 'string' || !UUID.test(id))
    return fail('Select one retained sale receipt.', 400);
  const value = await db
    .prepare(`SELECT r.owner_id AS ownerId,r.id AS receiptId,r.project_id AS projectId,r.preparation_id AS preparationId,r.intent_id AS intentId,r.project_revision AS projectRevision,r.wallet_revision AS walletRevision,r.signature,i.wallet_address AS wallet,i.state,r.document AS receiptDocument,p.document AS preparationDocument,i.document AS approvalDocument
FROM imported_swap_receipts r
JOIN imported_swap_preparations p ON p.owner_id=r.owner_id AND p.id=r.preparation_id AND p.project_id=r.project_id AND p.project_revision=r.project_revision AND p.wallet_revision=r.wallet_revision
JOIN imported_swap_signing_intents i ON i.owner_id=r.owner_id AND i.id=r.intent_id AND i.preparation_id=p.id AND i.signature=r.signature AND i.wallet_address=p.wallet_address AND i.state='finalized'
JOIN solana_swap_signatures s ON s.owner_id=r.owner_id AND s.signature=r.signature AND s.scope='imported' AND s.intent_id=i.id
WHERE r.owner_id=? AND r.id=?`)
    .bind(owner, id)
    .first<ImportedSaleParent>();
  if (!value)
    return fail(
      'A finalized owned sale with its original preparation, approval and signature registration is required.',
      404,
    );
  return requireImportedSaleParent(value);
}
async function existing(db: D1Database, owner: string, id: string) {
  return db
    .prepare(
      'SELECT * FROM imported_sale_receipt_evidence WHERE owner_id=? AND receipt_id=?',
    )
    .bind(owner, id)
    .first<Row>();
}
async function verified(
  row: Row,
  owner: string,
  p: ImportedSaleParent,
  signal: AbortSignal,
) {
  if (
    row.owner_id !== owner ||
    row.receipt_id !== p.receiptId ||
    row.signature !== p.signature ||
    row.parent !== canonical(p)
  )
    return fail('The retained sale evidence row differs.');
  const evidence = await parseImportedSaleEvidence(
    JSON.parse(row.evidence),
    p,
    signal,
  );
  if (
    row.parent_sha256 !== evidence.parentSha256 ||
    row.sha256 !== evidence.sha256 ||
    row.created_at !== evidence.observedAt
  )
    return fail('The retained sale evidence binding differs.');
  return evidence;
}
async function stable(
  db: D1Database,
  owner: string,
  p: ImportedSaleParent,
  row: Row | null,
  signal: AbortSignal,
) {
  const afterRow = await existing(db, owner, p.receiptId);
  signal.throwIfAborted();
  if (canonical(afterRow) !== canonical(row))
    return fail(
      'Sale evidence changed while it was being checked. Reload its history.',
    );
  const after = await parent(db, owner, p.receiptId);
  signal.throwIfAborted();
  if (canonical(after) !== canonical(p))
    return fail(
      'The sale source changed while its evidence was being checked.',
    );
}
function summary(p: ImportedSaleParent, e: ImportedSaleEvidence | null) {
  const receipt = JSON.parse(p.receiptDocument) as {
    mint: string;
    wallet: string;
  };
  return {
    receiptId: p.receiptId,
    mint: receipt.mint,
    wallet: receipt.wallet,
    entry: e
      ? {
          sha256: e.sha256,
          observedAt: e.observedAt,
          slot: e.report.slot,
          tokenUnitsRaw: e.report.acquiredRaw,
          networkFeeLamports: e.report.networkFeeLamports,
          nativeSettlementRaw: e.report.nativeSettlementRaw,
          executionAllowed: false as const,
          profitCalculated: false as const,
        }
      : null,
  };
}
/** Private accounting source. Never serialize raw signed metadata to HTTP. */
export async function readOwnedImportedSaleSource(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await guards(db);
  const p = await parent(db, owner, id),
    row = await existing(db, owner, id);
  if (!row)
    return fail(
      'Retain this sale’s finalized receipt metadata before assigning launch acquisitions.',
      404,
    );
  const evidence = await verified(row, owner, p, signal);
  await stable(db, owner, p, row, signal);
  return { parent: p, row, evidence };
}
/** Database-only reload, with no provider configuration or mutation. */
export async function readOwnedImportedSaleEvidence(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await guards(db);
  const p = await parent(db, owner, id),
    row = await existing(db, owner, id),
    evidence = row ? await verified(row, owner, p, signal) : null;
  await stable(db, owner, p, row, signal);
  return summary(p, evidence);
}
/** Explicit two-read capture. Natural receipt identity recovers retries without
 * a new provider call; no approval, reservations, lots or execution are changed. */
export async function retainOwnedImportedSaleEvidence(
  db: D1Database,
  owner: string,
  id: string,
  signal: AbortSignal,
  rpc: ImportedSaleEvidenceRpc,
) {
  signal.throwIfAborted();
  await guards(db);
  const p = await parent(db, owner, id),
    row = await existing(db, owner, id);
  if (row) {
    const evidence = await verified(row, owner, p, signal);
    await stable(db, owner, p, row, signal);
    return summary(p, evidence);
  }
  const count = await db
    .prepare(
      'SELECT count(*) AS n FROM imported_sale_receipt_evidence WHERE owner_id=?',
    )
    .bind(owner)
    .first<{ n: number }>();
  if (!count || count.n >= 4000)
    return fail(
      'Retained sale evidence capacity reached. Existing evidence remains readable.',
    );
  signal.throwIfAborted();
  const now = Date.now();
  const gate = await db
    .prepare(
      'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
    )
    .bind(
      JSON.stringify(['sale-receipt-evidence-v1', owner, id]),
      now + 5000,
      now,
    )
    .run();
  if (!gate.meta.changes)
    return fail(
      'Wait five seconds before reading this sale receipt again. Saved evidence remains available.',
      429,
    );
  const evidence = await collectImportedSaleEvidence(p, signal, rpc);
  signal.throwIfAborted();
  try {
    await db
      .prepare(
        'INSERT INTO imported_sale_receipt_evidence(owner_id,receipt_id,signature,parent,parent_sha256,evidence,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        owner,
        id,
        p.signature,
        canonical(p),
        evidence.parentSha256,
        canonical(evidence),
        evidence.sha256,
        evidence.observedAt,
      )
      .run();
  } catch {
    const recovered = await existing(db, owner, id);
    if (!recovered)
      return fail(
        'The sale or evidence changed before saving. Reload its saved history before retrying.',
      );
    const retained = await verified(recovered, owner, p, signal);
    await stable(db, owner, p, recovered, signal);
    return summary(p, retained);
  }
  return readOwnedImportedSaleEvidence(db, owner, id, signal);
}
