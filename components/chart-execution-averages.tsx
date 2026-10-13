import {
  chartExecutionAverages,
  type ExecutionAverage,
} from '@/lib/chart-execution-averages';
import type { ImportedTradeReceipt } from '@/lib/imported-trade-ledger';
function Average({
  side,
  value,
}: {
  side: 'Buy' | 'Sell';
  value: ExecutionAverage | null;
}) {
  return (
    <div>
      <dt>Average {side.toLowerCase()} · SOL per token</dt>
      <dd>
        {value ? (
          <>
            <strong>{value.display}</strong>
            {value.truncated && <span> (display truncated)</span>}
            <details>
              <summary>Exact weighted price</summary>
              <p>
                {value.receiptCount} loaded {side.toLowerCase()} receipts ·{' '}
                {value.tokenUnitsRaw} atomic token units ·{' '}
                {value.settlementLamports} settlement lamports.
              </p>
              <p className="warmup-address">
                Exact SOL/token fraction: {value.numerator} /{' '}
                {value.denominator}
              </p>
            </details>
          </>
        ) : (
          'No loaded receipts for this side.'
        )}
      </dd>
    </div>
  );
}
export function ChartExecutionAverages({
  receipts,
  projectId,
  mint,
  decimals,
  hasOlder,
  chartCurrency = 'usd',
}: {
  receipts: ImportedTradeReceipt[];
  projectId: string;
  mint: string;
  decimals: number;
  hasOlder: boolean;
  chartCurrency?: 'usd' | 'sol';
}) {
  const averages = chartExecutionAverages(receipts, projectId, mint, decimals);
  return (
    <section aria-label="Recorded average execution prices">
      <h5>Recorded average execution prices</h5>
      <dl className="supply-split-grid">
        <Average side="Buy" value={averages.buy} />
        <Average side="Sell" value={averages.sell} />
      </dl>
      <p>
        Token-unit-weighted SOL settlement across {averages.receiptCount} loaded
        finalized receipts. Includes recorded routes and wallets; excludes
        separate network fees, rent and bundle tips.
      </p>
      {hasOlder && (
        <output>
          Older receipts remain outside this calculation. Load older chart
          trades to extend coverage, up to 500.
        </output>
      )}
      <p>
        {chartCurrency === 'sol'
          ? 'Dashed lines compare loaded receipt averages in SOL; only averages inside the current price range are drawn.'
          : 'USD chart overlays require a matching price denomination or retained exchange rate.'}
      </p>
    </section>
  );
}
