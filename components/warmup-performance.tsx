'use client';
import { useState } from 'react';
import { Button } from './ui/button';
import type { WarmupLotPerformance } from '@/lib/warmup-lot-performance';
import {
  formatNativeBalance,
  signedBalanceAmount,
} from '@/lib/wallet-balance-format';

export function WarmupPerformance({
  performance: p,
}: {
  performance: WarmupLotPerformance;
}) {
  const [requestedPage, setPage] = useState(0);
  const page = Math.min(
    requestedPage,
    Math.max(0, Math.ceil(p.lots.length / 50) - 1),
  );
  return (
    <section
      className="warmup-performance"
      aria-label="Recorded warmup performance"
    >
      <h5>Recorded lot performance</h5>
      <p>
        Uses the same revision scope as cycle progress. Buy cost includes
        successful buy network fees. Sell proceeds exclude successful sell
        network fees. Buy cost is allocated proportionally to the units sold,
        using exact integer lamports. Account rent is separate.
      </p>
      {p.lotCount === 0 ? (
        <p>
          No finalized buy lots in this scope. No realized result is available.
        </p>
      ) : (
        <>
          <dl>
            <dt>Realized result after recorded swap fees</dt>
            <dd>
              {p.soldLotCount
                ? `${signedBalanceAmount(p.realizedResultLamports, 9)} SOL`
                : 'No recorded sells'}
            </dd>
            <dt>Net recorded sell proceeds</dt>
            <dd>{signedBalanceAmount(p.netSellProceedsLamports, 9)} SOL</dd>
            <dt>Buy cost allocated to sold units</dt>
            <dd>{formatNativeBalance(p.realizedCostLamports, 9)} SOL</dd>
            <dt>Open lot cost</dt>
            <dd>
              {formatNativeBalance(p.openCostLamports, 9)} SOL across{' '}
              {p.openLotCount} open lots
            </dd>
            <dt>Successful swap network fees, already included</dt>
            <dd>{formatNativeBalance(p.networkFeeLamports, 9)} SOL</dd>
            <dt>Net account rent change, separate</dt>
            <dd>{signedBalanceAmount(p.rentChangeLamports, 9)} SOL</dd>
          </dl>
          <p>
            Positive rent change means deposited account rent; negative means
            returned rent.
          </p>
          <p>
            {p.soldLotCount} of {p.lotCount} lots have recorded sells. Remaining
            lot cost is not a market valuation or an unrealized gain.
          </p>
          <details>
            <summary>Review linked lot results</summary>
            <div className="overflow-x-auto">
              <table>
                <caption>
                  Exact recorded source lots. No token units are combined across
                  different mints.
                </caption>
                <thead>
                  <tr>
                    <th>Source buy lot</th>
                    <th>Wallet / token</th>
                    <th>Sold / remaining units</th>
                    <th>Realized result</th>
                    <th>Open cost</th>
                  </tr>
                </thead>
                <tbody>
                  {p.lots.slice(page * 50, (page + 1) * 50).map((lot) => (
                    <tr key={lot.buyId}>
                      <td>
                        {lot.buyId}
                        <small>{lot.sellCount} linked sells</small>
                      </td>
                      <td>
                        <div>{lot.wallet}</div>
                        <div>{lot.mint}</div>
                      </td>
                      <td>
                        {formatNativeBalance(lot.soldRaw, lot.decimals)} /{' '}
                        {formatNativeBalance(lot.remainingRaw, lot.decimals)}
                        <small>
                          Raw sold: {lot.soldRaw}. Raw remaining:{' '}
                          {lot.remainingRaw}.
                        </small>
                      </td>
                      <td>
                        {lot.sellCount
                          ? `${signedBalanceAmount(lot.realizedResultLamports, 9)} SOL`
                          : 'No recorded sells'}
                      </td>
                      <td>
                        {formatNativeBalance(lot.openCostLamports, 9)} SOL
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Lots {page * 50 + 1} to {Math.min((page + 1) * 50, p.lots.length)}{' '}
              of {p.lots.length}
            </p>
            <Button
              variant="outline"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              Previous lots
            </Button>
            <Button
              variant="outline"
              disabled={(page + 1) * 50 >= p.lots.length}
              onClick={() => setPage(page + 1)}
            >
              Next lots
            </Button>
          </details>
        </>
      )}
      <p>
        Saved successful swaps only. External trades, transfers, failed
        transaction fees and pending executions are excluded. This is recorded
        lot accounting, not total account return.
      </p>
    </section>
  );
}
