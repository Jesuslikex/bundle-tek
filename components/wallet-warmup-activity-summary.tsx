'use client';
import {
  walletWarmupActivityTotals,
  type WalletWarmupActivity,
} from '@/lib/wallet-warmup-activity';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { Button } from './ui/button';
import styles from './wallet-warmup-activity-summary.module.css';

export function WalletWarmupActivitySummary({
  rows,
  revision,
  includeEarlier = false,
  archived = false,
  onRecover,
}: {
  rows: WalletWarmupActivity;
  revision?: number;
  includeEarlier?: boolean;
  archived?: boolean;
  onRecover?: (wallet: string) => void;
}) {
  let total: ReturnType<typeof walletWarmupActivityTotals>;
  try {
    if (
      (revision !== undefined &&
        (!Number.isSafeInteger(revision) || revision < 1)) ||
      typeof includeEarlier !== 'boolean' ||
      typeof archived !== 'boolean'
    )
      throw Error('Invalid scope');
    total = walletWarmupActivityTotals(rows);
  } catch {
    return (
      <section
        className={styles.summary}
        aria-label="Recorded activity by wallet"
      >
        <p role="alert">
          Recorded activity totals are unavailable. Refresh cycle progress
          before reviewing these results. Approval recovery remains available in
          the per-step progress table.
        </p>
      </section>
    );
  }
  const title =
    total.state === 'complete'
      ? 'All recorded loops complete'
      : total.state === 'recovery'
        ? 'Recovery required'
        : total.state === 'empty'
          ? 'No wallets in this recorded view'
          : total.state === 'unrecorded'
            ? 'No recorded trades'
            : 'Partially recorded activity';
  const sol = (raw: string) => formatNativeBalance(raw, 9) + ' SOL';
  return (
    <section
      className={styles.summary}
      aria-label="Recorded activity by wallet"
      data-state={total.state}
    >
      <header className={styles.heading}>
        <div>
          <h5>Activity by wallet</h5>
          <output className={styles.status}>{title}</output>
        </div>
        <span className={styles.badge}>
          {archived ? 'Archived plan' : 'Receipt history'}
        </span>
      </header>
      {rows.length === 0 && (
        <p>
          {revision === undefined
            ? 'Recorded plan history'
            : `Saved revision ${revision}`}
          .{' '}
          {includeEarlier
            ? 'Earlier matching revisions included.'
            : 'Current captured revisions only.'}
        </p>
      )}
      <dl className={styles.metrics}>
        <div>
          <dt>Wallets complete</dt>
          <dd>
            {total.recoveryCount > 0
              ? 'Awaiting recovery'
              : `${total.completedWallets} / ${total.walletCount}`}
          </dd>
        </div>
        <div>
          <dt>Recorded loops</dt>
          <dd>
            {total.recoveryCount > 0
              ? 'Awaiting recovery'
              : `${total.completedCycles} / ${total.totalCycles}`}
          </dd>
        </div>
        <div>
          <dt>Finalized transactions</dt>
          <dd>
            {total.transactionCount}{' '}
            <small>
              {total.buyTransactions}{' '}
              {total.buyTransactions === 1 ? 'buy' : 'buys'} ·{' '}
              {total.sellTransactions}{' '}
              {total.sellTransactions === 1 ? 'sell' : 'sells'}
            </small>
          </dd>
        </div>
        <div>
          <dt>Recorded SOL volume</dt>
          <dd>{sol(total.volumeLamports)}</dd>
        </div>
      </dl>
      {total.totalCycles > 0 && total.recoveryCount === 0 && (
        <progress
          className={styles.overall}
          aria-label="Recorded warmup loops"
          value={total.completedCycles}
          max={total.totalCycles}
        />
      )}
      {total.recoveryCount > 0 && (
        <p className={styles.warning}>
          {total.recoveryCount} saved swap approval
          {total.recoveryCount === 1 ? ' needs' : 's need'} recovery across{' '}
          {total.recoveryWallets} wallet{total.recoveryWallets === 1 ? '' : 's'}
          . These may belong to another plan. Loop counts are withheld until
          recovery. Open recovery to check their outcomes before preparing
          another trade.
        </p>
      )}
      {rows.length > 0 && (
        <table className={styles.table}>
          <caption>
            Recorded activity by wallet.{' '}
            {revision === undefined
              ? 'Recorded plan history'
              : `Saved revision ${revision}`}
            .{' '}
            {includeEarlier
              ? 'Earlier matching revisions included.'
              : 'Current captured revisions only.'}
          </caption>
          <thead>
            <tr>
              <th scope="col">Wallet / loops</th>
              <th scope="col">Finalized tx</th>
              <th scope="col">SOL volume</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.wallet}>
                <th scope="row">
                  <details className={styles.details}>
                    <summary aria-label={`Wallet details for ${row.wallet}`}>
                      <span className={styles.walletLabel}>
                        <code title={row.wallet}>
                          {row.wallet.length > 14
                            ? row.wallet.slice(0, 5) +
                              '…' +
                              row.wallet.slice(-4)
                            : row.wallet}
                        </code>
                        <span className={styles.rowState}>{row.state}</span>
                        <span className={styles.loopLine}>
                          {row.recoveryCount > 0 ? (
                            <small>Loop count withheld</small>
                          ) : (
                            <>
                              <progress
                                aria-label={`Recorded loops for ${row.wallet}`}
                                value={row.completedCycles}
                                max={row.totalCycles}
                              />
                              <small>
                                {row.completedCycles} / {row.totalCycles}
                              </small>
                            </>
                          )}
                        </span>
                      </span>
                      <span aria-hidden="true" className={styles.detailHint} />
                    </summary>
                    <div className={styles.breakdown}>
                      <code className={styles.fullWallet}>{row.wallet}</code>
                      <p>
                        Buy spending: {sol(row.buyVolumeLamports)}. Sell
                        proceeds: {sol(row.sellVolumeLamports)}.
                      </p>
                      <p>Turnover is not profit or a current wallet balance.</p>
                    </div>
                  </details>
                  {row.recoveryCount > 0 && onRecover && (
                    <Button
                      variant="outline"
                      className={styles.recovery}
                      aria-label={`Recover saved approvals for ${row.wallet}`}
                      onClick={() => onRecover(row.wallet)}
                    >
                      Open approval recovery
                    </Button>
                  )}
                </th>
                <td>
                  <strong>{row.transactionCount}</strong>{' '}
                  <small>
                    ({row.buyTransactions}{' '}
                    {row.buyTransactions === 1 ? 'buy' : 'buys'},{' '}
                    {row.sellTransactions}{' '}
                    {row.sellTransactions === 1 ? 'sell' : 'sells'})
                  </small>
                </td>
                <td>
                  <strong>{sol(row.volumeLamports)}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        Finalized receipts only, not a running session or current wallet
        balances. SOL volume adds buy spending and sell proceeds before network
        fees and account rent. Pending and external transactions are excluded.
        Recorded completion does not prove profit or wallet readiness.
      </p>
    </section>
  );
}
