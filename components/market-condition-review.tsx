'use client';
import { useEffect, useId, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { reviewMarketTrigger, marketGrid } from '@/lib/market-trigger';
import { solanaTokenAtoms } from '@/lib/solana-token-amount';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { SavedTokenMarket } from '@/lib/token-market';
import { ConditionalSellOrders } from './conditional-sell-orders';
export function MarketConditionReview({
  project,
  observation,
  pair,
  feedRunning = false,
}: {
  project: ImportedTokenProject;
  observation: SavedTokenMarket;
  pair: string;
  feedRunning?: boolean;
}) {
  const id = useId(),
    [direction, setDirection] = useState<'at-or-above' | 'at-or-below'>(
      'at-or-above',
    ),
    [target, setTarget] = useState(''),
    [limitAmount, setLimitAmount] = useState(''),
    [minimum, setMinimum] = useState(''),
    [maximum, setMaximum] = useState(''),
    [lines, setLines] = useState('5'),
    [amount, setAmount] = useState('');
  const [review, setReview] = useState<
      | (ReturnType<typeof reviewMarketTrigger> & {
          observation: SavedTokenMarket;
        })
      | null
    >(null),
    [grid, setGrid] = useState<ReturnType<typeof marketGrid> | null>(null),
    [error, setError] = useState(''),
    [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!review) return;
    const timer = window.setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(review.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [review]);
  const changed = () => {
    setReview(null);
    setGrid(null);
    setError('');
    setExpired(false);
  };
  const current = review && review.observation === observation && !expired;
  return (
    <section
      aria-label="Market cap condition review"
      className="imported-trade-wallets"
    >
      <h4>Market-cap conditions</h4>
      <p>
        Review market-cap conditions and exact grid amounts for the selected
        pool. These previews do not place orders.
      </p>
      <div className="imported-trade-wallet-filters">
        <label>
          Condition
          <select
            value={direction}
            onChange={(e) => {
              changed();
              setDirection(e.target.value as typeof direction);
            }}
          >
            <option value="at-or-above">Market cap at or above</option>
            <option value="at-or-below">Market cap at or below</option>
          </select>
        </label>
        <label htmlFor={id + 'target'}>
          Target market cap (USD)
          <Input
            id={id + 'target'}
            inputMode="decimal"
            value={target}
            onChange={(e) => {
              changed();
              setTarget(e.target.value);
            }}
          />
        </label>
      </div>
      <label htmlFor={id + 'limitamount'}>
        Limit sell amount ({project.document.token.symbol})
        <Input
          id={id + 'limitamount'}
          inputMode="decimal"
          value={limitAmount}
          onChange={(e) => {
            changed();
            setLimitAmount(e.target.value);
          }}
        />
      </label>
      <Button
        variant="outline"
        disabled={project.archived}
        onClick={() => {
          changed();
          try {
            setReview({
              ...reviewMarketTrigger(
                { pair, direction, targetUsd: target },
                observation,
                {
                  chain: project.document.token.chain,
                  mint: project.document.token.address,
                  revision: project.revision,
                },
              ),
              observation,
            });
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Condition unavailable.');
          }
        }}
      >
        Review market-cap condition
      </Button>
      {review && (
        <output style={{ display: 'block' }}>
          {current
            ? review.met
              ? 'Condition met in the sampled observation.'
              : 'Condition not met in the sampled observation.'
            : 'Condition observation expired or replaced. Review again.'}{' '}
          Observed ${review.observedMarketCapUsd} against ${review.targetUsd},{' '}
          {review.observedAt}. Freshness ends {review.expiresAt}. This does not
          guarantee a fill or authorize signing.
        </output>
      )}
      <h5>Grid amount allocation</h5>
      <p>
        Distribute an exact sell amount across increasing market-cap levels.
        Rounding residue stays in the final level. These are proposed levels,
        not placed orders or an inventory check.
      </p>
      <div className="imported-trade-wallet-filters">
        <label htmlFor={id + 'minimum'}>
          Minimum market cap (USD)
          <Input
            id={id + 'minimum'}
            inputMode="decimal"
            value={minimum}
            onChange={(e) => {
              changed();
              setMinimum(e.target.value);
            }}
          />
        </label>
        <label htmlFor={id + 'maximum'}>
          Maximum market cap (USD)
          <Input
            id={id + 'maximum'}
            inputMode="decimal"
            value={maximum}
            onChange={(e) => {
              changed();
              setMaximum(e.target.value);
            }}
          />
        </label>
        <label htmlFor={id + 'lines'}>
          Grid levels
          <Input
            id={id + 'lines'}
            inputMode="numeric"
            value={lines}
            onChange={(e) => {
              changed();
              setLines(e.target.value);
            }}
          />
        </label>
        <label htmlFor={id + 'amount'}>
          Total sell amount ({project.document.token.symbol})
          <Input
            id={id + 'amount'}
            inputMode="decimal"
            value={amount}
            onChange={(e) => {
              changed();
              setAmount(e.target.value);
            }}
          />
        </label>
      </div>
      <Button
        variant="outline"
        disabled={project.archived || project.document.token.chain !== 'Solana'}
        onClick={() => {
          changed();
          try {
            if (!/^[1-9]\d?$/.test(lines))
              throw new Error('Use 2 to 50 grid levels.');
            setGrid(
              marketGrid({
                minimumUsd: minimum,
                maximumUsd: maximum,
                lines: Number(lines),
                totalRaw: solanaTokenAtoms(
                  amount,
                  project.document.token.decimals,
                ).toString(),
                decimals: project.document.token.decimals,
              }),
            );
          } catch (e) {
            setError(
              e instanceof Error ? e.message : 'Grid allocation unavailable.',
            );
          }
        }}
      >
        Review grid allocations
      </Button>
      {error && <p role="alert">{error}</p>}
      {grid && (
        <div className="imported-trade-wallet-table">
          <table>
            <caption>
              Proposed sell levels for pool {pair}. No orders placed.
            </caption>
            <thead>
              <tr>
                <th scope="col">Level</th>
                <th scope="col">Market cap USD</th>
                <th scope="col">Token amount</th>
                <th scope="col">Atomic units</th>
              </tr>
            </thead>
            <tbody>
              {grid.map((row) => (
                <tr key={row.level}>
                  <td>{row.level}</td>
                  <td>{row.targetUsd}</td>
                  <td>{row.amount}</td>
                  <td>{row.unitsRaw}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {project.document.token.chain === 'Solana' && (
        <ConditionalSellOrders
          key={`${project.id}:${project.revision}:${pair}`}
          project={project}
          pair={pair}
          observation={observation}
          feedRunning={feedRunning}
          limit={
            current
              ? { direction, targetUsd: review!.targetUsd, amount: limitAmount }
              : undefined
          }
          grid={
            grid
              ? {
                  minimumUsd: minimum,
                  maximumUsd: maximum,
                  lines: Number(lines),
                  amount,
                }
              : undefined
          }
        />
      )}
    </section>
  );
}
