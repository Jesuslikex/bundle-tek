'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { validatedAccountCosts, type AccountCosts } from '@/lib/account-costs';
import { formatNativeBalance } from '@/lib/wallet-balance-format';

export function AccountCostSummary({ value }: { value: AccountCosts }) {
  const incomplete =
    value.pendingCount +
    value.missingFailureCount +
    value.missingFinalizedCount;
  return (
    <div>
      <p>
        <strong>{formatNativeBalance(value.totalFeeLamports, 9)} SOL</strong>{' '}
        recorded network fees across {value.receiptCount} finalized receipts.
      </p>
      <p>
        Successful transactions:{' '}
        {formatNativeBalance(value.successfulFeeLamports, 9)} SOL. Failed
        transactions: {formatNativeBalance(value.failedFeeLamports, 9)} SOL.
      </p>
      <div className="project-table-wrap">
        <table className="project-table">
          <caption className="sr-only">
            Recorded mainnet fees by workflow
          </caption>
          <thead>
            <tr>
              <th>Workflow</th>
              <th>Successful</th>
              <th>Failed</th>
              <th>Network fees (SOL)</th>
            </tr>
          </thead>
          <tbody>
            {value.categories.map((row) => (
              <tr key={row.category}>
                <td>{row.category}</td>
                <td>{row.successCount}</td>
                <td>{row.failedCount}</td>
                <td>
                  {formatNativeBalance(
                    (
                      BigInt(row.successfulFeeLamports) +
                      BigInt(row.failedFeeLamports)
                    ).toString(),
                    9,
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        {incomplete
          ? 'Fee coverage is incomplete.'
          : value.receiptCount === 0
            ? 'No finalized receipts are saved in these workflows.'
            : 'All saved transactions in the checked workflows have fee evidence.'}{' '}
        Signed or submitted transactions awaiting settlement:{' '}
        {value.pendingCount}. Failed transactions without captured fee evidence:{' '}
        {value.missingFailureCount}. Finalized swaps without a saved receipt:{' '}
        {value.missingFinalizedCount}.
      </p>
      <small>
        Checked {new Date(value.observedAt).toLocaleString()}. Includes archived
        projects and earlier revisions. Mainnet Solana only. External
        transactions, funding executions, launches, token transfer fees and rent
        are excluded. These fees are not total account return or portfolio
        value.
      </small>
    </div>
  );
}
export function AccountCostsPanel() {
  const [value, setValue] = useState<AccountCosts | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function load() {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setError('');
    setValue(null);
    try {
      const response = await fetch('/api/account-costs', {
        cache: 'no-store',
        signal: current.signal,
      });
      const body: unknown = await response.json();
      if (!response.ok)
        throw new Error(
          'Account costs unavailable. No partial totals are shown.',
        );
      const summary = validatedAccountCosts(body);
      if (!current.signal.aborted) setValue(summary);
    } catch (e) {
      if (!current.signal.aborted)
        setError(e instanceof Error ? e.message : 'Account costs unavailable.');
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  }
  return (
    <section
      aria-label="Account transaction costs"
      className="account-costs-panel"
    >
      <h2>Account transaction costs</h2>
      <p>
        Review saved swap and withdrawal network fees, including failed
        execution costs.
      </p>
      <Button variant="outline" onClick={load} disabled={busy}>
        {busy
          ? 'Checking saved receipts…'
          : value
            ? 'Refresh account costs'
            : 'Review account costs'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {value && <AccountCostSummary value={value} />}
    </section>
  );
}
