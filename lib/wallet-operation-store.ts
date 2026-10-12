import type { WalletAuditEvent } from './distribution-audit';
import type { WalletOperationDocument } from './wallet-operation';
export async function resolveWalletOperation(
  db: D1Database,
  owner: string,
  id: string,
  event: WalletAuditEvent,
) {
  const op = await db
    .prepare(
      'SELECT wallet_address,document,state,signature,created_at,armed_at,minimum_slot FROM wallet_operations WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<{
      wallet_address: string;
      document: string;
      state: string;
      signature: string | null;
      created_at: string;
      armed_at: string | null;
      minimum_slot: number | null;
    }>();
  if (
    !op ||
    op.wallet_address !== event.walletAddress ||
    !event.transactionSignature
  )
    return false;
  const failed =
    event.eventType === 'memo_failed' ||
    event.eventType === 'token_transfer_failed' ||
    event.eventType === 'native_transfer_failed';
  const terminal = failed ? 'failed' : 'finalized';
  if (
    !op.armed_at ||
    !['awaiting_signature', 'submitted', terminal].includes(op.state) ||
    (op.signature && op.signature !== event.transactionSignature)
  )
    return false;
  const intent = JSON.parse(op.document) as WalletOperationDocument,
    details = JSON.parse(event.details) as Record<string, unknown>;
  if (
    event.createdAt < op.created_at ||
    !Number.isSafeInteger(op.minimum_slot) ||
    op.minimum_slot === null ||
    typeof details.slot !== 'number' ||
    !Number.isSafeInteger(details.slot) ||
    details.slot <= op.minimum_slot
  )
    return false;
  if (
    intent.kind === 'memo'
      ? event.eventType !== (failed ? 'memo_failed' : 'memo_finalized')
      : intent.kind === 'sol'
        ? event.eventType !==
            (failed ? 'native_transfer_failed' : 'native_transfer_finalized') ||
          details.fundingKey !== intent.fundingKey ||
          details.recipient !== intent.recipient ||
          details.amount !== intent.amount
        : event.eventType !==
            (failed ? 'token_transfer_failed' : 'token_transfer_finalized') ||
          (intent.funding && details.fundingKey !== intent.funding.key) ||
          details.distributionKey !== intent.distributionKey ||
          details.recipient !== intent.recipient
  )
    return false;
  if (op.state === terminal) return op.signature === event.transactionSignature;
  const result = await db
    .prepare(`UPDATE wallet_operations SET state=?,signature=?,updated_at=? WHERE owner_id=? AND id=? AND state IN ('awaiting_signature','submitted') AND (signature IS NULL OR signature=?)
  AND NOT EXISTS(SELECT 1 FROM wallet_operations WHERE owner_id=? AND signature=? AND id<>?)`)
    .bind(
      terminal,
      event.transactionSignature,
      new Date().toISOString(),
      owner,
      id,
      event.transactionSignature,
      owner,
      event.transactionSignature,
      id,
    )
    .run();
  return !!result.meta.changes;
}
