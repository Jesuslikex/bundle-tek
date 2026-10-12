import type { SupplyMovementEvidence } from '@/lib/supply-movement-evidence';
import {
  summarizeSupplyMovements,
  type MovementSummaryScope,
} from '@/lib/supply-movement-summary';
import {
  formatNativeBalance,
  signedBalanceAmount,
} from '@/lib/wallet-balance-format';
export function SupplyMovementSummary({
  records,
  scope,
}: {
  records: SupplyMovementEvidence[];
  scope: MovementSummaryScope;
}) {
  const summary = summarizeSupplyMovements(records, scope);
  if (!summary.ok) return <p role="alert">{summary.error}</p>;
  const rows = [
    ['Decoded buys', summary.buckets.buy],
    ['Decoded sells', summary.buckets.sell],
    ['Transfers in', summary.buckets.transferIn],
    ['Transfers out', summary.buckets.transferOut],
    ['Unknown movements (net)', summary.buckets.unknown],
  ] as const;
  return (
    <section
      aria-label="Inspected wallet activity totals"
      className="min-w-0 space-y-2 rounded-md border p-3"
    >
      <h4>Inspected wallet activity</h4>
      <p>
        {summary.transactionCount} unique decoded transactions for this saved
        alert. Duplicate signatures across indexes count once.
      </p>
      <table className="w-full text-left">
        <caption>Activity in the loaded evidence</caption>
        <thead>
          <tr>
            <th scope="col">Movement</th>
            <th scope="col">Count</th>
            <th scope="col">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, bucket]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{bucket.count}</td>
              <td className="break-all">
                {label === 'Unknown movements (net)'
                  ? signedBalanceAmount(bucket.raw.toString(), scope.decimals)
                  : formatNativeBalance(bucket.raw.toString(), scope.decimals)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Saved balance change:{' '}
        {signedBalanceAmount(summary.observedDeltaRaw, scope.decimals)}. Decoded
        transaction net:{' '}
        {signedBalanceAmount(summary.decodedNetRaw, scope.decimals)}.
        Unexplained difference:{' '}
        {signedBalanceAmount(summary.unexplainedRaw, scope.decimals)}.
      </p>
      <p>
        {summary.balancesMatch
          ? 'Decoded net matches the saved balance change. Offsetting missing transactions can still exist.'
          : 'Decoded net does not reconcile with the saved balance change. Continue inspection before drawing activity conclusions.'}
      </p>
      <p>
        Coverage remains partial. Totals cover loaded successful token decodes;
        unavailable transactions and closed or reassigned token accounts may be
        missing. These are token units, not trade value, full wallet history or
        P&amp;L.
      </p>
    </section>
  );
}
