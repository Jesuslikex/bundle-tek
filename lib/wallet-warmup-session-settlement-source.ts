import { z } from 'zod';
import { walletWarmupSessionDigest as digest } from './wallet-warmup-session-digest';

const text = z.string().max(1048576);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const rowSchema = z
  .object({
    receiptWallet: text.nullable(),
    remainingRaw: text.nullable(),
    receiptId: text,
    receiptPlanId: text,
    receiptSignature: text,
    receiptDocument: text,
    receiptPlanRevision: integer.nullable(),
    receiptWalletRevision: integer.nullable(),
    receiptCycle: integer.nullable(),
    buyReceiptId: text.nullable(),
    consumedRaw: text.nullable(),
    preparationId: text,
    planId: text,
    planRevision: integer,
    cycle: integer,
    walletRevision: integer,
    preparationCreatedAt: text,
    preparationDocument: text,
    approvalId: text,
    approvalPreparationId: text,
    approvalWallet: text,
    approvalSignature: text,
    approvalState: text,
    approvalDocument: text,
  })
  .strict();
export type WarmupSessionSettlementSourceRow = z.infer<typeof rowSchema>;
const sideSchema = z.enum(['Buy', 'Sell']);

/** Closed projection shared by the real verifier's read and a later SQL write guard. */
export function warmupSessionSettlementSourceSql(value: 'Buy' | 'Sell') {
  const side = sideSchema.parse(value);
  const table = side === 'Buy' ? 'warmup_buy_receipts' : 'warmup_sell_receipts';
  const specific =
    side === 'Buy'
      ? 'r.wallet_address AS receiptWallet,r.remaining_raw AS remainingRaw,r.plan_revision AS receiptPlanRevision,r.wallet_revision AS receiptWalletRevision,r.cycle AS receiptCycle,NULL AS buyReceiptId,NULL AS consumedRaw'
      : 'NULL AS receiptWallet,NULL AS remainingRaw,NULL AS receiptPlanRevision,NULL AS receiptWalletRevision,NULL AS receiptCycle,r.buy_receipt_id AS buyReceiptId,r.consumed_raw AS consumedRaw';
  return `SELECT r.id AS receiptId,r.plan_id AS receiptPlanId,r.signature AS receiptSignature,r.document AS receiptDocument,${specific},
    s.id AS preparationId,s.plan_id AS planId,s.plan_revision AS planRevision,s.cycle,s.wallet_revision AS walletRevision,s.created_at AS preparationCreatedAt,s.document AS preparationDocument,
    i.id AS approvalId,i.preparation_id AS approvalPreparationId,i.wallet_address AS approvalWallet,i.signature AS approvalSignature,i.state AS approvalState,i.document AS approvalDocument
    FROM ${table} r JOIN warmup_swap_preparations s ON s.owner_id=r.owner_id AND s.id=r.preparation_id
    JOIN warmup_signing_intents i ON i.owner_id=s.owner_id AND i.preparation_id=s.id
    WHERE r.owner_id=? AND r.id=? AND r.plan_id=? AND EXISTS(SELECT 1 FROM wallet_warmup_plans p WHERE p.owner_id=r.owner_id AND p.id=r.plan_id)`;
}

/**
 * An insertion-time fact comparison, NEVER receipt verification or authorization.
 * The internal caller must independently run replayWarmupSessionSettlement and
 * use that exact result. Never admit a request-body snapshot as verified evidence.
 * Execute the predicate inside the SAME statement/transaction as the guarded
 * write; a separate SELECT of it leaves the race open.
 */
export async function warmupSessionSettlementSourceGuard(
  owner: string,
  side: 'Buy' | 'Sell',
  evidence: { sourceDocument: string; sourceSha256: string },
) {
  const fail = (): never => {
    throw Error(
      'Finalized settlement source binding is unavailable or changed.',
    );
  };
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(owner)) return fail();
  const selected = sideSchema.parse(side);
  // Copy scalar bytes before hashing. No provider or database read happens here.
  const document = evidence.sourceDocument,
    sha = evidence.sourceSha256;
  if (
    typeof document !== 'string' ||
    new TextEncoder().encode(document).byteLength > 4194304 ||
    !/^[a-f0-9]{64}$/.test(sha) ||
    (await digest(document)) !== sha
  )
    return fail();
  let rows: [
    WarmupSessionSettlementSourceRow,
    WarmupSessionSettlementSourceRow | null,
  ];
  try {
    rows = z
      .tuple([rowSchema, rowSchema.nullable()])
      .parse(JSON.parse(document));
  } catch {
    return fail();
  }
  if (
    (selected === 'Buy' && rows[1] !== null) ||
    (selected === 'Sell' && rows[1] === null)
  )
    return fail();
  const bindings: (string | number | null)[] = [];
  function exists(row: WarmupSessionSettlementSourceRow, kind: 'Buy' | 'Sell') {
    const keys = Object.keys(
      rowSchema.shape,
    ) as (keyof WarmupSessionSettlementSourceRow)[];
    bindings.push(
      owner,
      row.receiptId,
      row.receiptPlanId,
      ...keys.map((key) => row[key]),
    );
    // Keys and table names are closed source constants, never caller SQL.
    return `EXISTS(SELECT 1 FROM (${warmupSessionSettlementSourceSql(kind)}) AS captured WHERE ${keys.map((key) => `captured.${key} IS ?`).join(' AND ')})`;
  }
  const clauses = [exists(rows[0], selected)];
  if (rows[1]) clauses.push(exists(rows[1], 'Buy'));
  return {
    sql: `(${clauses.join(' AND ')})`,
    bindings,
    executionAllowed: false as const,
    signingAllowed: false as const,
    automaticExecutionAllowed: false as const,
  };
}
