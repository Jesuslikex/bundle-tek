import type { NativeWithdrawalFailureReceipt } from '@/lib/withdrawal-failure';
import { withdrawalFailureLabel } from '@/lib/withdrawal-failure';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
export function WithdrawalFailureEvidence({
  receipt,
}: {
  receipt?: NativeWithdrawalFailureReceipt | null;
}) {
  return receipt ? (
    <div aria-label="Verified withdrawal failure">
      <p>
        Verified finalized failure at slot {receipt.slot}:{' '}
        {withdrawalFailureLabel(receipt.error)}.
      </p>
      <p>
        Actual network fee {formatNativeBalance(receipt.networkFeeLamports, 9)}{' '}
        SOL. Wallet SOL debit{' '}
        {formatNativeBalance(receipt.networkFeeLamports, 9)} SOL. The failed
        transaction did not complete the requested transfer.
      </p>
      {receipt.feeLimitExceeded && (
        <p role="alert">
          The charged network fee exceeded the reviewed fee limit.
        </p>
      )}
      <p>
        Observed {new Date(receipt.observedAt).toLocaleString()} via{' '}
        {receipt.source}
        {receipt.blockTime === null
          ? ''
          : ` · block time ${new Date(receipt.blockTime * 1000).toLocaleString()}`}
        .
      </p>
    </div>
  ) : (
    <p>
      Failure fee and error evidence was not captured in this record. This
      record does not establish the execution cost.
    </p>
  );
}
