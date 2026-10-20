'use client';
import type { WalletWarmupActivity } from '@/lib/wallet-warmup-activity';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import styles from './wallet-warmup-activity-summary.module.css';

export function WalletWarmupActivitySummary({
  rows,
}: {
  rows: WalletWarmupActivity;
}) {
  return (
    <section
      className={styles.summary}
      aria-label="Recorded activity by wallet"
    >
      <h5>Activity by wallet</h5>
      <p>
        Saved finalized receipts in the selected revision scope. SOL volume adds
        buy spending and sell proceeds before network fees and account rent.
        Pending or external transactions are excluded. This view does not run
        trades.
      </p>
      <ul>
        {rows.map((row) => (
          <li key={row.wallet}>
            <code>{row.wallet}</code>
            <strong>{row.state}</strong>
            <progress
              aria-label={`Recorded loops for ${row.wallet}`}
              value={row.completedCycles}
              max={row.totalCycles}
            />
            <dl>
              <div>
                <dt>Recorded loops</dt>
                <dd>
                  {row.completedCycles} / {row.totalCycles}
                </dd>
              </div>
              <div>
                <dt>Finalized transactions</dt>
                <dd>
                  {row.transactionCount}{' '}
                  <small>
                    ({row.buyTransactions}{' '}
                    {row.buyTransactions === 1 ? 'buy' : 'buys'},{' '}
                    {row.sellTransactions}{' '}
                    {row.sellTransactions === 1 ? 'sell' : 'sells'})
                  </small>
                </dd>
              </div>
              <div>
                <dt>Recorded SOL volume</dt>
                <dd>{formatNativeBalance(row.volumeLamports, 9)} SOL</dd>
              </div>
            </dl>
            {row.recoveryCount > 0 && (
              <p>
                {row.recoveryCount} active approval
                {row.recoveryCount === 1 ? ' needs' : 's need'} recovery.
                Resolve these approvals before preparing another trade.
              </p>
            )}
            <details>
              <summary>Volume breakdown</summary>
              <p>
                Buy spending: {formatNativeBalance(row.buyVolumeLamports, 9)}{' '}
                SOL. Sell proceeds:{' '}
                {formatNativeBalance(row.sellVolumeLamports, 9)} SOL. Turnover
                is not profit or a current wallet balance.
              </p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
