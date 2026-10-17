'use client';
import { useEffect, useRef, useState } from 'react';
import { ImportedTradePerformance } from './imported-trade-performance';
import { ImportedLotLinks } from './imported-lot-links';
import { ImportedReceiptChart } from './imported-receipt-chart';
import type { ImportedPerformance } from '@/lib/imported-performance-format';
import { Button } from './ui/button';
import { Input } from './ui/input';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { ImportedSwapReceipt } from '@/lib/imported-approval-history';
import {
  importedTradePage,
  type ImportedTradeReceipt,
  type ImportedTradeSummary,
} from '@/lib/imported-trade-ledger';
import {
  formatNativeBalance,
  signedBalanceAmount,
} from '@/lib/wallet-balance-format';

export function ImportedTradeTotals({
  summary,
  symbol,
  decimals,
}: {
  summary: ImportedTradeSummary;
  symbol: string;
  decimals: number;
}) {
  return (
    <div className="dashboard-stats">
      <article>
        <span>Finalized swaps</span>
        <strong>{summary.receiptCount}</strong>
        <small>
          {summary.buyCount} buys · {summary.sellCount} sells
        </small>
      </article>
      <article>
        <span>Tokens bought / sold</span>
        <strong>
          {formatNativeBalance(summary.boughtRaw, decimals)} /{' '}
          {formatNativeBalance(summary.soldRaw, decimals)}
        </strong>
        <small>
          {symbol} · recorded token change{' '}
          {signedBalanceAmount(summary.netTokenChangeRaw, decimals)}
        </small>
      </article>
      <article>
        <span>SOL spent / received</span>
        <strong>
          {formatNativeBalance(summary.solSpentRaw, 9)} /{' '}
          {formatNativeBalance(summary.solReceivedRaw, 9)}
        </strong>
        <small>Swap settlement before network fees and rent</small>
      </article>
      <article>
        <span>Network fees</span>
        <strong>
          {formatNativeBalance(summary.networkFeeLamports, 9)} SOL
        </strong>
        <small>Successful saved swaps only</small>
      </article>
    </div>
  );
}
export function ImportedTradeRecord({
  receipt,
  project,
  onReviewBuy,
}: {
  receipt: ImportedTradeReceipt;
  project: ImportedTokenProject;
  onReviewBuy?: (receipt: ImportedSwapReceipt) => void;
}) {
  const d = receipt.document;
  return (
    <article className="imported-trade-record">
      <div>
        <strong>
          {d.side} · {formatNativeBalance(d.tokenUnitsRaw, d.decimals)}{' '}
          {project.document.token.symbol}
        </strong>
        <span>Finalized · slot {d.slot}</span>
      </div>
      <p>{d.wallet}</p>
      <dl>
        <div>
          <dt>SOL settlement</dt>
          <dd>{signedBalanceAmount(d.nativeSettlementRaw, 9)} SOL</dd>
        </div>
        <div>
          <dt>Network fee</dt>
          <dd>{formatNativeBalance(d.networkFeeLamports, 9)} SOL</dd>
        </div>
        <div>
          <dt>Wallet SOL change</dt>
          <dd>{signedBalanceAmount(d.nativeChangeRaw, 9)} SOL</dd>
        </div>
      </dl>
      <details>
        <summary>Receipt evidence</summary>
        <p>
          Project revision {receipt.projectRevision} · wallet revision{' '}
          {receipt.walletRevision}
        </p>
        <p>Approval preparation {receipt.preparationId}</p>
        <p>Packet {d.preparationSha256}</p>
        <p>Rent change {signedBalanceAmount(d.rentChangeRaw, 9)} SOL</p>
        <p>
          Token units {d.tokenUnitsRaw} · decimals {d.decimals}
        </p>
        <p>
          Recorded {new Date(receipt.createdAt).toLocaleString()} · observed{' '}
          {new Date(d.observedAt).toLocaleString()} · source {d.source}
        </p>
        <p>
          Block time{' '}
          {d.blockTime === null
            ? 'Unavailable'
            : new Date(d.blockTime * 1000).toLocaleString()}
        </p>
      </details>
      <div className="wallet-roster-actions">
        {receipt.projectId === project.id &&
          receipt.document.mint === project.document.token.address && (
            <ImportedReceiptChart receipt={receipt} />
          )}
        <a
          href={`https://explorer.solana.com/tx/${encodeURIComponent(d.signature)}`}
          target="_blank"
          rel="noreferrer"
        >
          View finalized transaction
        </a>
        {!project.archived && d.side === 'Buy' && onReviewBuy && (
          <Button variant="outline" onClick={() => onReviewBuy(receipt)}>
            Review sell of acquired tokens
          </Button>
        )}
      </div>
    </article>
  );
}
export function ImportedTradeHistory({
  project,
  onReviewBuy,
}: {
  project: ImportedTokenProject;
  onReviewBuy?: (receipt: ImportedSwapReceipt) => void;
}) {
  const [open, setOpen] = useState(false),
    [receipts, setReceipts] = useState<ImportedTradeReceipt[]>([]),
    [performance, setPerformance] = useState<ImportedPerformance | null>(null),
    [summary, setSummary] = useState<ImportedTradeSummary | null>(null),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [search, setSearch] = useState(''),
    [side, setSide] = useState('All'),
    [observedAt, setObservedAt] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function read(older = false) {
    if (busy) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      const token = project.document.token;
      const response = await fetch(
        `/api/imported-projects/receipts?projectId=${encodeURIComponent(project.id)}${older && cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
        {
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(15000),
          ]),
        },
      );
      const value = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(value.error || 'Finalized trade history unavailable.');
      const page = importedTradePage(
        value,
        project.id,
        token.address,
        token.decimals,
      );
      if (controller.signal.aborted || pending.current !== controller) return;
      setReceipts((prior) =>
        older
          ? [
              ...prior,
              ...page.receipts.filter(
                (row) => !prior.some((old) => old.id === row.id),
              ),
            ]
          : page.receipts,
      );
      setSummary(page.summary);
      setPerformance(page.performance);
      setCursor(page.nextCursor);
      setObservedAt(page.observedAt);
    } catch (err) {
      if (!controller.signal.aborted && pending.current === controller) {
        setError(
          err instanceof Error
            ? err.message
            : 'Finalized trade history unavailable.',
        );
        setSummary(null);
        setPerformance(null);
      }
    } finally {
      if (!controller.signal.aborted && pending.current === controller)
        setBusy(false);
    }
  }
  const filtered = receipts.filter(
    (row) =>
      (side === 'All' || row.document.side === side) &&
      `${row.document.wallet} ${row.document.signature} ${row.id} ${row.preparationId}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  return (
    <section
      className="imported-trade-history"
      aria-label="Finalized project trades"
    >
      <div className="wallet-roster-actions">
        <h3>Finalized trades</h3>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setOpen(true);
            void read();
          }}
        >
          {open ? 'Refresh finalized trades' : 'View finalized trades'}
        </Button>
        {open && (
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Hide finalized trades
          </Button>
        )}
      </div>
      {open && (
        <>
          <p>
            Only saved, verified finalized swaps are included. Totals cover this
            project across wallets, revisions and archives. Token changes are
            not current holdings, and SOL settlement is not profit. External
            transfers, failed-transaction fees and other wallet activity are
            excluded.
          </p>
          {error && (
            <p role="alert" className="tracker-error">
              {error}
            </p>
          )}
          {busy && <output>Loading saved finalized trades…</output>}
          {summary && (
            <>
              <ImportedTradeTotals
                summary={summary}
                symbol={project.document.token.symbol}
                decimals={project.document.token.decimals}
              />
              {performance && (
                <ImportedTradePerformance
                  key={project.id}
                  performance={performance}
                  decimals={project.document.token.decimals}
                  symbol={project.document.token.symbol}
                />
              )}
              <p className="tracker-note">
                All {summary.receiptCount} saved finalized swaps · read{' '}
                {new Date(observedAt).toLocaleString()}. Filters below apply to
                loaded receipts.
              </p>
              {summary.receiptCount > 0 && (
                <a
                  className="imported-trade-export"
                  href={`/api/imported-projects/receipts?projectId=${encodeURIComponent(project.id)}&format=csv`}
                  download
                >
                  Export all saved trades as CSV
                </a>
              )}
            </>
          )}
          <ImportedLotLinks
            key={`${project.id}:${project.revision}`}
            project={project}
          />
          {summary?.receiptCount === 0 && (
            <p>
              No finalized trades recorded for this project. Quotes,
              simulations, signatures and cancelled approvals are excluded.
            </p>
          )}
          {receipts.length > 0 && (
            <>
              <div className="project-toolbar">
                <Input
                  aria-label="Search finalized trades"
                  placeholder="Wallet, signature or receipt ID"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <select
                  aria-label="Finalized trade side"
                  value={side}
                  onChange={(e) => setSide(e.target.value)}
                >
                  <option>All</option>
                  <option>Buy</option>
                  <option>Sell</option>
                </select>
              </div>
              <p>
                {filtered.length} matching receipts of {receipts.length} loaded
              </p>
              {filtered.map((receipt) => (
                <ImportedTradeRecord
                  key={receipt.id}
                  receipt={receipt}
                  project={project}
                  onReviewBuy={onReviewBuy}
                />
              ))}
              {cursor && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void read(true)}
                >
                  Load older finalized trades
                </Button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
