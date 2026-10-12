import type { WalletAuditEvent } from './distribution-audit';
import {
  operationDocument,
  UUID,
  type WalletOperation,
} from './wallet-operation';
import { fundingLink } from './devnet-saved-funding';
import { assertTransactionSignature } from './solana-transfer-receipt';
import { toBaseUnits } from './distribution-plan';

export type FundingReceipt = {
  id: string;
  wallet: string;
  recipient: string;
  amount: string;
  mint: string | null;
  decimals: number;
  rawAmount: string;
  signature: string;
  slot: number;
  blockTime: number | null;
  verifiedAt: string;
  fundingRevision: number;
  key: string;
  outcome: 'finalized' | 'failed';
  feeLamports: string | null;
  transactionError: string | null;
};
export type FundingPendingOperation = {
  id: string;
  wallet: string;
  recipient: string;
  amount: string;
  mint: string | null;
  state: 'preparing' | 'awaiting_signature' | 'submitted';
  signature: string | null;
  createdAt: string;
  fundingRevision: number;
};
export type FundingExecutionHistory = {
  id: string;
  revision: number;
  archived: boolean;
  receipts: FundingReceipt[];
  pending: FundingPendingOperation[];
  pendingTruncated: boolean;
  nextCursor: string | null;
};

function iso(value: string) {
  if (value.length !== 24 || new Date(value).toISOString() !== value)
    throw new Error('Invalid retained history timestamp.');
  return value;
}
function u64(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) >= 1n << 64n
  )
    throw new Error('Invalid retained exact amount.');
  return value;
}
export async function fundingReceipt(
  event: WalletAuditEvent,
  id: string,
): Promise<FundingReceipt> {
  const details = JSON.parse(event.details) as Record<string, unknown>;
  const native = event.eventType.startsWith('native_transfer_');
  const failed = event.eventType.endsWith('_failed');
  if (
    !UUID.test(event.id) ||
    event.network !== 'devnet' ||
    ![
      'native_transfer_finalized',
      'native_transfer_failed',
      'token_transfer_finalized',
      'token_transfer_failed',
    ].includes(event.eventType) ||
    details.fundingId !== id ||
    details.commitment !== 'finalized' ||
    !Number.isSafeInteger(details.slot) ||
    Number(details.slot) < 1 ||
    !(
      details.blockTime === null ||
      (Number.isSafeInteger(details.blockTime) &&
        Number(details.blockTime) >= 0)
    ) ||
    (!native &&
      (!Number.isSafeInteger(details.decimals) ||
        Number(details.decimals) < 0 ||
        Number(details.decimals) > 255))
  )
    throw new Error('Retained funding evidence is inconsistent.');
  const intent = await operationDocument(
    native
      ? {
          kind: 'sol',
          wallet: event.walletAddress,
          fundingId: id,
          fundingRevision: details.fundingRevision,
          recipient: details.recipient,
          amount: details.amount,
        }
      : {
          kind: 'spl',
          wallet: event.walletAddress,
          recipient: details.recipient,
          distribution: {
            wallet: event.walletAddress,
            mint: details.mint,
            recipients: [
              { address: details.recipient, amount: details.amount },
            ],
          },
          funding: { id, revision: details.fundingRevision },
        },
  );
  const link = fundingLink(intent)!;
  const amount =
    intent.kind === 'sol'
      ? intent.amount
      : intent.kind === 'spl'
        ? intent.distribution.recipients[0].amount
        : '';
  const decimals = native ? 9 : Number(details.decimals);
  if (
    link.key !== details.fundingKey ||
    toBaseUnits(amount, decimals).toString() !== u64(details.rawAmount) ||
    (failed &&
      (typeof details.transactionError !== 'string' ||
        !details.transactionError ||
        details.transactionError.length > 2048))
  )
    throw new Error('Retained funding intent differs from its receipt.');
  return {
    id: event.id,
    wallet: intent.wallet,
    recipient: String(details.recipient),
    amount,
    mint: intent.kind === 'spl' ? intent.distribution.mint : null,
    decimals,
    rawAmount: String(details.rawAmount),
    signature: assertTransactionSignature(event.transactionSignature),
    slot: Number(details.slot),
    blockTime: details.blockTime === null ? null : Number(details.blockTime),
    verifiedAt: iso(event.createdAt),
    fundingRevision: link.revision,
    key: link.key,
    outcome: failed ? 'failed' : 'finalized',
    feeLamports:
      details.feeLamports === undefined ? null : u64(details.feeLamports),
    transactionError: failed ? String(details.transactionError) : null,
  };
}
export async function fundingPendingOperation(
  op: WalletOperation,
  id: string,
): Promise<FundingPendingOperation> {
  const intent = await operationDocument(JSON.parse(op.document));
  const link = fundingLink(intent);
  if (
    !UUID.test(op.id) ||
    !link ||
    link.id !== id ||
    intent.wallet !== op.walletAddress ||
    !['preparing', 'awaiting_signature', 'submitted'].includes(op.state) ||
    intent.kind === 'memo' ||
    (op.state === 'submitted' ? op.signature === null : op.signature !== null)
  )
    throw new Error('Retained funding reservation is inconsistent.');
  return {
    id: op.id,
    wallet: intent.wallet,
    recipient: intent.recipient,
    amount:
      intent.kind === 'sol'
        ? intent.amount
        : intent.distribution.recipients[0].amount,
    mint: intent.kind === 'spl' ? intent.distribution.mint : null,
    state: op.state as FundingPendingOperation['state'],
    signature:
      op.signature === null ? null : assertTransactionSignature(op.signature),
    createdAt: iso(op.createdAt),
    fundingRevision: link.revision,
  };
}
