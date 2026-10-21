import {
  walletWarmupSessionDigest,
  WARMUP_SESSION_SOURCE_BYTES,
  WARMUP_SESSION_SOURCE_FORMAT,
} from './wallet-warmup-session-digest';
import { WARMUP_HISTORY_LIMIT } from './warmup-history-capacity';
import { canonicalPumpHolderJson } from './pump-holder-review';
import type { WarmupV2AttemptRow } from './wallet-warmup-session-v2-attempt-types';
import type { WarmupSessionPreparationCandidate } from './wallet-warmup-session-preparation';
function fail(): never {
  throw Error('Original finalized receipt floor is unavailable or differs.');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail();
  return value as Record<string, unknown>;
}
function slot(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    return fail();
  return value;
}
function units(value: unknown) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value))
    return fail();
  const n = BigInt(value);
  if (n > (1n << 64n) - 1n) return fail();
  return n;
}
function document(row: Record<string, unknown>) {
  if (typeof row.document !== 'string') return fail();
  return object(JSON.parse(row.document));
}
function finalized(row: Record<string, unknown>, doc: Record<string, unknown>) {
  if (
    row.verified !== 1 ||
    row.commitment !== 'finalized' ||
    row.network !== 'mainnet' ||
    doc.signatureVerified !== true ||
    doc.commitment !== 'finalized' ||
    doc.network !== 'mainnet' ||
    doc.executionAllowed !== false ||
    doc.instructionsVerified !== false
  )
    fail();
}
/** Derive a lower bound from the original immutable owned source, not a caller's slot. */
export async function readWarmupRuntimeReceiptFloor(
  db: D1Database,
  lease: WarmupV2AttemptRow,
  candidate: WarmupSessionPreparationCandidate,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (candidate.action.side !== 'Sell' || !candidate.sellSource) return fail();
  const row = await db
    .prepare(`SELECT c.source_document,r.source_sha256 FROM wallet_warmup_session_v2_attempt_context c
 JOIN wallet_warmup_session_journals_v2 j ON j.owner_id=c.owner_id AND j.id=c.journal_id
 JOIN wallet_warmup_session_reviews r ON r.owner_id=j.owner_id AND r.id=j.review_id AND r.source=c.source_document
 WHERE c.owner_id=? AND c.journal_id=? AND c.version=? AND c.head_sha256=? AND c.terms_sha256=? AND c.action_id=? AND c.plan_id=? AND c.plan_revision=?`)
    .bind(
      lease.owner_id,
      lease.journal_id,
      lease.review_version,
      lease.review_sha256,
      lease.terms_sha256,
      lease.action_id,
      candidate.plan.id,
      candidate.plan.revision,
    )
    .first<{ source_document: string; source_sha256: string }>();
  signal.throwIfAborted();
  if (
    !row ||
    new TextEncoder().encode(row.source_document).byteLength >
      WARMUP_SESSION_SOURCE_BYTES ||
    (await walletWarmupSessionDigest(row.source_document)) !== row.source_sha256
  )
    return fail();
  const source = object(JSON.parse(row.source_document));
  if (
    canonicalPumpHolderJson(source) !== row.source_document ||
    source.format !== WARMUP_SESSION_SOURCE_FORMAT ||
    source.planDocument !== candidate.planDocument ||
    !Array.isArray(source.buys) ||
    !Array.isArray(source.sells) ||
    source.buys.length > WARMUP_HISTORY_LIMIT ||
    source.sells.length > WARMUP_HISTORY_LIMIT
  )
    return fail();
  const buys = source.buys
    .map(object)
    .filter((b) => b.id === candidate.sellSource!.buyReceiptId);
  if (buys.length !== 1) return fail();
  const buy = buys[0],
    doc = document(buy),
    remaining = units(buy.remainingRaw);
  finalized(buy, doc);
  if (
    buy.wallet !== candidate.action.wallet ||
    buy.cycle !== candidate.action.cycle ||
    buy.mint !== candidate.action.mint ||
    doc.wallet !== candidate.action.wallet ||
    doc.mint !== candidate.action.mint ||
    buy.remainingRaw !== candidate.sellSource.remainingRaw ||
    doc.decimals !== candidate.sellSource.decimals
  )
    return fail();
  const buySlot = slot(doc.slot);
  let floor = buySlot,
    consumed = 0n;
  for (const sale of source.sells
    .map(object)
    .filter((s) => s.buyId === buy.id)) {
    const evidence = document(sale);
    finalized(sale, evidence);
    const at = slot(evidence.slot),
      amount = units(sale.consumedRaw);
    if (
      at <= buySlot ||
      !amount ||
      evidence.buyReceiptId !== buy.id ||
      evidence.consumedRaw !== sale.consumedRaw ||
      evidence.wallet !== doc.wallet ||
      evidence.mint !== doc.mint ||
      evidence.decimals !== doc.decimals ||
      evidence.tokenProgram !== doc.tokenProgram
    )
      return fail();
    floor = Math.max(floor, at);
    consumed += amount;
  }
  if (consumed + remaining !== units(doc.acquiredRaw)) return fail();
  signal.throwIfAborted();
  return floor;
}
