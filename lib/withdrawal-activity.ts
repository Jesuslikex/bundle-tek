import { withdrawalFailureLabel } from './withdrawal-failure';
import {
  validatedNativeWithdrawal,
  type NativeWithdrawal,
} from './native-withdrawal';
export type WithdrawalActivityEvent = {
  sequence: number;
  createdAt: string;
  withdrawal: NativeWithdrawal;
};
export async function validatedWithdrawalActivity(
  value: unknown,
): Promise<WithdrawalActivityEvent> {
  const event = value as WithdrawalActivityEvent;
  if (
    !event ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    !Number.isFinite(Date.parse(event.createdAt)) ||
    event.createdAt !== event.withdrawal?.updatedAt
  )
    throw new Error('Withdrawal event context differs.');
  await validatedNativeWithdrawal(event.withdrawal);
  return event;
}
export function withdrawalActivityLabel(state: NativeWithdrawal['state']) {
  return {
    awaiting_signature: 'Withdrawal review retained',
    signing: 'Withdrawal signing started',
    signed: 'Withdrawal signature registered',
    submitted: 'Withdrawal submission started; check finalized outcome',
    finalized: 'Withdrawal finalized',
    failed: 'Withdrawal execution failed',
    cancelled: 'Unsigned withdrawal cancelled',
  }[state];
}
export function withdrawalActivityDetail(event: WithdrawalActivityEvent) {
  const row = event.withdrawal,
    review = row.document;
  const parts = [
    `${review.amount} ${review.token ? 'tokens' : 'SOL'} requested`,
    `from ${review.wallet}`,
    `to ${review.recipient}`,
    `wallet revision ${review.walletRevision}`,
    `withdrawal ${row.id}`,
    `captured state ${row.state}`,
    `packet ${review.sha256}`,
  ];
  if (review.token)
    parts.push(
      `mint ${review.token.mint}`,
      `${review.token.decimals} decimals`,
    );
  if (row.signature) parts.push(`registered signature ${row.signature}`);
  if (row.receipt) {
    parts.push(
      `verified finalized slot ${row.receipt.slot}`,
      `network fee ${row.receipt.networkFeeLamports} lamports`,
    );
    if (row.receipt.token)
      parts.push(
        `recipient received ${row.receipt.token.destinationChangeRaw} atomic token units`,
        `token fee ${row.receipt.token.transferFeeRaw ?? '0'} atomic units`,
        `recipient account rent ${row.receipt.token.accountRentLamports} lamports`,
      );
    else
      parts.push(
        `recipient received ${row.receipt.recipientChangeRaw} lamports`,
      );
  } else if (row.failureReceipt) {
    parts.push(
      `verified finalized failure slot ${row.failureReceipt.slot}`,
      withdrawalFailureLabel(row.failureReceipt.error),
      `actual network fee ${row.failureReceipt.networkFeeLamports} lamports`,
      `wallet SOL debit ${row.failureReceipt.networkFeeLamports} lamports`,
    );
  } else
    parts.push(
      'No successful finalized transfer receipt recorded at this transition',
    );
  return parts.join(' · ');
}
