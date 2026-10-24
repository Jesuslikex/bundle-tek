'use client';

import { useState } from 'react';
import { Button } from './ui/button';
import {
  summarizePortfolio,
  type PerformanceScopeLite,
  type PortfolioHoldings,
  type PortfolioSummary,
} from '@/lib/portfolio';
import { formatNativeBalance } from '@/lib/wallet-balance-format';

const sol = (lamports: bigint) => {
  const negative = lamports < 0n;
  return (
    (negative ? '-' : '') +
    formatNativeBalance((negative ? -lamports : lamports).toString(), 9) +
    ' SOL'
  );
};
const usd = (value: number) =>
  value.toLocaleString(undefined, { style: 'currency', currency: 'USD' });

async function read<T>(url: string) {
  const response = await fetch(url, { cache: 'no-store' });
  const value = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) throw new Error(value.error || 'Portfolio unavailable.');
  return value;
}

/**
 * Portfolio P&L: what your proven Solana wallets hold now, valued from each
 * token's latest saved market observation, plus recorded realized results.
 */
export function PortfolioPanel() {
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [holdings, setHoldings] = useState<PortfolioHoldings | null>(null);
  const [solUsd, setSolUsd] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load() {
    setBusy(true);
    setError('');
    try {
      const [current, performance, prices] = await Promise.all([
        read<PortfolioHoldings>('/api/portfolio'),
        read<{ scopes: PerformanceScopeLite[] }>('/api/account-performance'),
        read<{ prices?: { symbol: string; usd: number }[] }>(
          '/api/market-prices',
        ).catch(() => ({ prices: [] })),
      ]);
      const price = prices.prices?.find((p) => p.symbol === 'SOL')?.usd ?? null;
      setSolUsd(price);
      setHoldings(current);
      setSummary(summarizePortfolio(current, performance.scopes ?? [], price));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Portfolio unavailable.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Portfolio" className="native-withdrawal-panel">
      <div className="wallet-roster-actions">
        <h3>Portfolio P&amp;L</h3>
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          {busy ? 'Reading…' : summary ? 'Refresh' : 'Load portfolio'}
        </Button>
      </div>
      {summary && holdings && (
        <>
          <dl className="tracker-note">
            <div>
              <dt>Total P&amp;L</dt>
              <dd>{sol(summary.totalLamports)}</dd>
            </div>
            <div>
              <dt>Realized (recorded sales)</dt>
              <dd>{sol(summary.realizedLamports)}</dd>
            </div>
            <div>
              <dt>Unrealized (held value minus open cost)</dt>
              <dd>{sol(summary.unrealizedLamports)}</dd>
            </div>
            <div>
              <dt>Tokens held, valued</dt>
              <dd>{sol(summary.holdingsValueLamports)}</dd>
            </div>
            <div>
              <dt>SOL in {holdings.walletCount} wallets</dt>
              <dd>{sol(summary.solLamports)}</dd>
            </div>
          </dl>
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>Held</th>
                <th>Value</th>
                <th>Open cost</th>
                <th>Unrealized</th>
                <th>Realized</th>
              </tr>
            </thead>
            <tbody>
              {summary.rows.map((row) => (
                <tr key={row.projectId}>
                  <td title={row.mint}>{row.symbol}</td>
                  <td>
                    {formatNativeBalance(row.heldRaw, row.decimals)} (
                    {row.walletCount} wallet{row.walletCount === 1 ? '' : 's'})
                  </td>
                  <td>
                    {row.valueLamports === null
                      ? 'no saved price'
                      : `${sol(row.valueLamports)} · ${usd(row.valueUsd!)}`}
                  </td>
                  <td>{sol(row.openCostLamports)}</td>
                  <td>
                    {row.unrealizedLamports === null
                      ? '—'
                      : sol(row.unrealizedLamports)}
                  </td>
                  <td>{sol(row.realizedLamports)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="tracker-note">
            Values use each token&apos;s latest saved market price
            {solUsd ? ` and SOL at ${usd(solUsd)}` : ''}. Refresh a token&apos;s
            market to update it.
            {summary.unpricedCount > 0 &&
              ` ${summary.unpricedCount} held token${summary.unpricedCount === 1 ? ' has' : 's have'} no saved price and ${summary.unpricedCount === 1 ? 'is' : 'are'} left out of the totals.`}
            {holdings.walletsOmitted > 0 &&
              ` ${holdings.walletsOmitted} more wallets were not read.`}
            {holdings.projectsOmitted > 0 &&
              ` ${holdings.projectsOmitted} older tokens were not read.`}{' '}
            Open cost is the cost of recorded buys not yet matched to a sale;
            unrecorded transfers and fees are not included.
          </p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
