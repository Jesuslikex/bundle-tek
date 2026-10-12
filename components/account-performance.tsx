'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  validatedAccountPerformance,
  type AccountPerformance,
} from '@/lib/account-performance';
import {
  formatNativeBalance,
  signedBalanceAmount,
} from '@/lib/wallet-balance-format';

export function AccountPerformanceSummary({
  value,
}: {
  value: AccountPerformance;
}) {
  const searchId = useId();
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(0);
  const rows = value.scopes.filter((r) =>
    `${r.name} ${r.kind} ${r.id} ${r.archived ? 'archived' : 'active'}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  return (
    <div>
      <div className="dashboard-stats">
        <article>
          <span>Recorded realized result</span>
          <strong>
            {value.recordedRealizedLamports === null
              ? 'Unavailable'
              : `${signedBalanceAmount(value.recordedRealizedLamports, 9)} SOL`}
          </strong>
          <small>
            {value.sellCount === 0
              ? 'No recorded sales'
              : value.unlinkedSaleCount
                ? `${value.unlinkedSaleCount} sales have unassigned acquisition basis`
                : 'All recorded sales have linked buy evidence'}
          </small>
        </article>
        <article>
          <span>Linked sales result</span>
          <strong>
            {value.linkedSaleCount
              ? `${signedBalanceAmount(value.linkedResultLamports, 9)} SOL`
              : 'No linked sales'}
          </strong>
          <small>
            {value.linkedSaleCount} linked sales. After allocated buy and sell
            network fees.
          </small>
        </article>
        <article>
          <span>Unallocated recorded buy cost</span>
          <strong>
            {formatNativeBalance(value.unallocatedCostLamports, 9)} SOL
          </strong>
          <small>
            Includes buys without assigned exits. Not current token value.
          </small>
        </article>
      </div>
      <p>
        {value.receiptCount} finalized trade receipts across{' '}
        {value.scopes.length} projects and warmup plans. Successful network
        fees: {formatNativeBalance(value.successfulFeeLamports, 9)} SOL. Rent
        change, kept separate:{' '}
        {signedBalanceAmount(value.rentChangeLamports, 9)} SOL.
      </p>
      <label htmlFor={searchId}>
        Search recorded projects and plans
        <Input
          id={searchId}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
      </label>
      <a
        className={buttonVariants({ variant: 'outline' })}
        href="/api/account-performance?format=csv"
        download="bundle-recorded-performance.csv"
      >
        Export all recorded performance
      </a>
      <small>
        Export reads a fresh complete account snapshot, including scopes hidden
        by search.
      </small>
      <div className="project-table-wrap">
        <table className="project-table">
          <caption>
            Recorded results by project or plan. Archived scopes and earlier
            revisions are included.
          </caption>
          <thead>
            <tr>
              <th>Project or plan</th>
              <th>Workflow</th>
              <th>Linked / unassigned sales</th>
              <th>Linked result (SOL)</th>
              <th>Unallocated cost (SOL)</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(page * 50, (page + 1) * 50).map((r) => (
              <tr key={`${r.kind}:${r.id}`}>
                <td>
                  {r.name}
                  {r.archived && <small>Archived</small>}
                  <small>{r.id}</small>
                </td>
                <td>{r.kind}</td>
                <td>
                  {r.linkedSaleCount} / {r.unlinkedSaleCount}
                </td>
                <td>
                  {r.linkedSaleCount
                    ? signedBalanceAmount(r.linkedResultLamports, 9)
                    : 'No linked sales'}
                </td>
                <td>{formatNativeBalance(r.unallocatedCostLamports, 9)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <p>
          {value.scopes.length
            ? 'No recorded scopes match your search.'
            : 'No finalized trade receipts are saved.'}
        </p>
      )}
      {rows.length > 50 && (
        <div>
          <Button
            variant="outline"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous results
          </Button>
          <span>
            {' '}
            Page {page + 1} of {Math.ceil(rows.length / 50)}{' '}
          </span>
          <Button
            variant="outline"
            disabled={(page + 1) * 50 >= rows.length}
            onClick={() => setPage((p) => p + 1)}
          >
            Next results
          </Button>
        </div>
      )}
      <small>
        Checked {new Date(value.observedAt).toLocaleString()}. Saved mainnet
        Solana trades only. Linked results include successful buy and sell
        network fees. Failed execution fees are reviewed in account transaction
        costs and are excluded here. Unassigned sales prevent a complete
        recorded realized result; they are not counted as profit. Unallocated
        cost can include already sold units awaiting assignment. External
        activity, withdrawals, funding, launches and market valuation are
        excluded. This is not total account return or portfolio value.
      </small>
    </div>
  );
}
export function AccountPerformancePanel() {
  const [value, setValue] = useState<AccountPerformance | null>(null),
    [busy, setBusy] = useState(false),
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
      const response = await fetch('/api/account-performance', {
        cache: 'no-store',
        signal: current.signal,
      });
      const body: unknown = await response.json();
      if (!response.ok)
        throw new Error(
          'Recorded trading performance unavailable. No partial totals are shown.',
        );
      const summary = validatedAccountPerformance(body);
      if (!current.signal.aborted) setValue(summary);
    } catch (e) {
      if (!current.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Recorded performance unavailable.',
        );
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  }
  return (
    <section
      className="account-costs-panel"
      aria-label="Recorded trading performance"
    >
      <h2>Recorded trading performance</h2>
      <p>
        Review linked buy-to-sell results across your imported projects and
        warmup plans.
      </p>
      <Button variant="outline" onClick={load} disabled={busy}>
        {busy
          ? 'Checking recorded trades…'
          : value
            ? 'Refresh recorded performance'
            : 'Review recorded performance'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {value && (
        <AccountPerformanceSummary key={value.observedAt} value={value} />
      )}
    </section>
  );
}
