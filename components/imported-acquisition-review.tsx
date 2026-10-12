import {
  importedAcquisitionCost,
  importedAcquisitionEntries,
  type ImportedAcquisitionSelection,
} from '@/lib/imported-acquisition';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
export function ImportedAcquisitionReview({
  acquisition: a,
}: {
  acquisition: ImportedAcquisitionSelection;
}) {
  const entries = importedAcquisitionEntries(a);
  return (
    <section aria-label="Selected acquisition accounting">
      <h5>Selected acquisition accounting</h5>
      <p>
        Wallet <code>{a.wallet}</code>. Total assigned input{' '}
        {formatNativeBalance(a.unitsRaw, a.decimals)} token units. Allocated buy
        cost, including proportional buy fees:{' '}
        {formatNativeBalance(importedAcquisitionCost(a), 9)} SOL.
      </p>
      {entries.map((part) => (
        <p key={part.buyReceiptId}>
          Buy receipt <code>{part.buyReceiptId}</code>. Assign{' '}
          {formatNativeBalance(part.unitsRaw, part.decimals)} token units.
          Allocated buy cost:{' '}
          {formatNativeBalance(part.allocatedCostLamports, 9)} SOL.
        </p>
      ))}
      <p>
        The saved sell receipt and acquisition links must commit together if the
        reviewed sell finalizes successfully. Failed or cancelled trades consume
        no acquisition units. Current balance and transaction settlement require
        their own checks.
      </p>
    </section>
  );
}
