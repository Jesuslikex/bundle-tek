'use client';
import { useId, useState } from 'react';
import type { ImportedPerformance } from '@/lib/imported-performance-format';
import {
  formatNativeBalance,
  signedBalanceAmount,
} from '@/lib/wallet-balance-format';
import { Button } from './ui/button';
import { PnlCardPanel } from './pnl-card-panel';

export function ImportedTradePerformance({
  performance,
  decimals,
  symbol,
}: {
  performance: ImportedPerformance;
  decimals: number;
  symbol?: string;
}) {
  const id = useId(),
    [show, setShow] = useState(false);
  return (
    <section
      className="imported-performance"
      aria-label="Recorded imported trade performance"
    >
      <label className="warmup-checkbox-choice" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={show}
          onChange={(e) => setShow(e.target.checked)}
        />
        <span>Show recorded FIFO accounting estimate</span>
      </label>
      {show && (
        <ImportedPerformanceResults
          performance={performance}
          decimals={decimals}
        />
      )}
      {show && symbol && (
        <PnlCardPanel performance={performance} symbol={symbol} />
      )}
    </section>
  );
}
export function ImportedPerformanceResults({
  performance: p,
  decimals,
}: {
  performance: ImportedPerformance;
  decimals: number;
}) {
  const [requestedPage, setPage] = useState(0);
  const page = Math.min(
    requestedPage,
    Math.max(0, Math.ceil(p.wallets.length / 50) - 1),
  );
  return (
    <>
      <h4>Recorded FIFO estimate</h4>
      {p.bundleCostStorageUnavailable && (
        <p role="alert">
          Bundle cost storage is unavailable. Known trade fees remain visible,
          but complete profit totals are withheld.
        </p>
      )}
      <p>
        Retained bundle tips:{' '}
        {p.bundleCostStorageUnavailable
          ? 'Unavailable'
          : formatNativeBalance(p.bundleTipLamports ?? '0', 9) + ' SOL'}
        . Tip transaction fees:{' '}
        {p.bundleCostStorageUnavailable
          ? 'Unavailable'
          : formatNativeBalance(p.bundleFeeLamports ?? '0', 9) + ' SOL'}
        .
      </p>
      {!!p.missingBundleCostCount && (
        <p role="alert">
          {p.missingBundleCostCount} bundles have incomplete cost evidence.
          Values include known costs only; complete realized estimates are
          unavailable.
        </p>
      )}
      <p>
        This model allocates sells to the earliest saved buys from the same
        wallet, ordered by finalized slot. It is an accounting assumption, not a
        verified buy-lot link. It covers all saved project swaps across
        revisions and archives. External holdings, trades, transfers and failed
        transaction fees are excluded.
      </p>
      {p.receiptCount === 0 ? (
        <p>
          No finalized swaps recorded. No performance estimate is available.
        </p>
      ) : (
        <>
          <div className="dashboard-stats">
            <article>
              <span>Recorded realized estimate</span>
              <strong>
                {p.realizedResultLamports === null
                  ? 'Unavailable'
                  : `${signedBalanceAmount(p.realizedResultLamports, 9)} SOL`}
              </strong>
              <small>
                {p.sellCount === 0
                  ? 'No recorded sells'
                  : p.realizedResultLamports === null
                    ? 'Acquisition basis, transaction order or bundle costs are incomplete'
                    : 'After successful trade fees and allocated bundle expenses'}
              </small>
            </article>
            <article>
              <span>Open recorded cost</span>
              <strong>
                {p.openCostLamports === null
                  ? 'Unavailable'
                  : `${formatNativeBalance(p.openCostLamports, 9)} SOL`}
              </strong>
              <small>
                Unconsumed app buys under this model. No market valuation.
              </small>
            </article>
            <article>
              <span>Sold units matched to earlier buys</span>
              <strong>{formatNativeBalance(p.matchedSoldRaw, decimals)}</strong>
              <small>Same-wallet recorded FIFO only</small>
            </article>
            <article>
              <span>Sold units with unknown basis</span>
              <strong>
                {formatNativeBalance(p.unknownBasisSoldRaw, decimals)}
              </strong>
              <small>Proceeds from these units are not counted as a gain</small>
            </article>
          </div>
          {p.wallets.some((w) => w.ordering === 'unavailable') && (
            <output className="imported-performance-order">
              Transaction order is unavailable for{' '}
              {p.wallets.filter((w) => w.ordering === 'unavailable').length}{' '}
              wallets. Multiple saved transactions share a finalized slot. Their{' '}
              {formatNativeBalance(p.unresolvedSoldRaw, decimals)} sold units
              and open cost are unresolved. Receipt timestamps do not establish
              on-chain order.
            </output>
          )}
          <p>
            Buy cost includes successful buy network fees. Net proceeds deduct
            successful sell network fees. Cost is allocated in integer lamports;
            Retained Jito tip and tip transaction fees are allocated equally
            across swap packets and included in buy basis or deducted from sell
            proceeds. complete lot exits consume rounding residue. Account rent
            remains separate in receipt evidence. These estimates are not total
            account return.
          </p>
          <details>
            <summary>Review wallet accounting coverage</summary>
            <div className="overflow-x-auto">
              <table>
                <caption>
                  All recorded project wallets. Same-slot ambiguity is withheld
                  rather than ordered by receipt ID.
                </caption>
                <thead>
                  <tr>
                    <th>Wallet</th>
                    <th>Coverage</th>
                    <th>Matched / unknown sold units</th>
                    <th>Realized estimate</th>
                    <th>Open recorded cost</th>
                  </tr>
                </thead>
                <tbody>
                  {p.wallets.slice(page * 50, (page + 1) * 50).map((w) => (
                    <tr key={w.wallet}>
                      <td>{w.wallet}</td>
                      <td>
                        {w.buyCount} buys / {w.sellCount} sells
                        <small>
                          {w.ordering === 'unavailable'
                            ? 'Same-slot order unavailable'
                            : w.unknownBasisSoldRaw !== '0'
                              ? 'Unknown acquisition basis'
                              : 'Recorded FIFO'}
                        </small>
                      </td>
                      <td>
                        {formatNativeBalance(w.matchedSoldRaw, decimals)} /{' '}
                        {formatNativeBalance(w.unknownBasisSoldRaw, decimals)}
                        {w.unresolvedSoldRaw !== '0' && (
                          <small>
                            {formatNativeBalance(w.unresolvedSoldRaw, decimals)}{' '}
                            order unresolved
                          </small>
                        )}
                      </td>
                      <td>
                        {w.realizedResultLamports === null
                          ? w.sellCount
                            ? 'Unavailable'
                            : 'No recorded sells'
                          : `${signedBalanceAmount(w.realizedResultLamports, 9)} SOL`}
                      </td>
                      <td>
                        {w.openCostLamports === null
                          ? 'Unavailable'
                          : `${formatNativeBalance(w.openCostLamports, 9)} SOL`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Wallets {page * 50 + 1} to{' '}
              {Math.min((page + 1) * 50, p.wallets.length)} of{' '}
              {p.wallets.length}
            </p>
            <Button
              variant="outline"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              Previous performance wallets
            </Button>
            <Button
              variant="outline"
              disabled={(page + 1) * 50 >= p.wallets.length}
              onClick={() => setPage(page + 1)}
            >
              Next performance wallets
            </Button>
          </details>
        </>
      )}
    </>
  );
}
