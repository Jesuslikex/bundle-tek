import type { SwapFailureReceipt } from '@/lib/swap-failure';
import { swapFailureDetail } from '@/lib/swap-failure';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
export function SwapFailureEvidence({
  receipt,
}: {
  receipt?: SwapFailureReceipt | null;
}) {
  return receipt ? (
    <div aria-label="Verified swap failure">
      <p>{swapFailureDetail(receipt)}</p>
      <p>
        Actual network fee {formatNativeBalance(receipt.networkFeeLamports, 9)}{' '}
        SOL. The failed transaction did not complete the requested swap. Failed
        execution fees are separate from successful trade performance.
      </p>
    </div>
  ) : (
    <p>
      Failure fee and error evidence was not captured in this record. This
      record does not establish the execution cost.
    </p>
  );
}
