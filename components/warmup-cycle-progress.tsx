'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from './ui/button';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import type { WarmupCycleProgress } from '@/lib/warmup-cycle-progress';
import type { WarmupLotPerformance } from '@/lib/warmup-lot-performance';
import { WarmupPerformance } from './warmup-performance';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { WARMUP_RECEIPT_SAVED } from '@/lib/warmup-receipt-events';
type Progress = WarmupCycleProgress & { performance: WarmupLotPerformance };
export function WarmupCycleProgress({
  plan,
  onReview,
}: {
  plan: SavedWarmup;
  onReview?: (step: Progress['steps'][number]) => void;
}) {
  const field = useId(),
    pending = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false),
    [earlier, setEarlier] = useState(false),
    [result, setResult] = useState<Progress | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [page, setPage] = useState(0);
  const read = useCallback(async () => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setResult(null);
    setPage(0);
    try {
      const response = await fetch(
        `/api/wallet-workspace/warmup/cycle-progress?id=${encodeURIComponent(plan.id)}&revision=${plan.revision}&includeEarlier=${earlier}`,
        {
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]),
        },
      );
      const data = (await response.json()) as Progress & { error?: string };
      if (
        !response.ok ||
        data.planId !== plan.id ||
        data.revision !== plan.revision ||
        data.includeEarlier !== earlier ||
        data.executionAllowed !== false ||
        data.archived !== plan.archived ||
        !data.performance ||
        !Number.isSafeInteger(data.performance.lotCount) ||
        !Number.isSafeInteger(data.performance.soldLotCount) ||
        !Number.isSafeInteger(data.performance.openLotCount) ||
        !Array.isArray(data.performance.lots) ||
        data.performance.lotCount !== data.performance.lots.length ||
        ![
          'realizedCostLamports',
          'openCostLamports',
          'netSellProceedsLamports',
          'realizedResultLamports',
          'networkFeeLamports',
          'rentChangeLamports',
        ].every(
          (key) =>
            typeof data.performance[key as keyof WarmupLotPerformance] ===
              'string' &&
            /^(0|-?[1-9]\d{0,24})$/.test(
              data.performance[key as keyof WarmupLotPerformance] as string,
            ),
        ) ||
        !Array.isArray(data.steps) ||
        data.steps.length !==
          plan.document.cycles * plan.document.addresses.length
      )
        throw new Error(data.error || 'Recorded cycle progress unavailable.');
      if (!controller.signal.aborted) setResult(data);
    } catch (err) {
      if (!controller.signal.aborted)
        setError(
          err instanceof Error
            ? err.message
            : 'Recorded cycle progress unavailable.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [
    plan.id,
    plan.revision,
    plan.archived,
    plan.document.cycles,
    plan.document.addresses.length,
    earlier,
  ]);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void Promise.resolve().then(() => {
      if (!disposed) void read();
    });
    const saved = (event: Event) => {
      if ((event as CustomEvent).detail?.planId === plan.id) void read();
    };
    window.addEventListener(WARMUP_RECEIPT_SAVED, saved);
    return () => {
      disposed = true;
      pending.current?.abort();
      window.removeEventListener(WARMUP_RECEIPT_SAVED, saved);
    };
  }, [open, read, plan.id]);
  return (
    <section
      className="warmup-cycle-progress"
      aria-label="Warmup cycle progress"
    >
      <Button
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Close cycle progress' : 'Open cycle progress'}
      </Button>
      {open && (
        <>
          <h5>Recorded cycle progress</h5>
          <p>
            Finalized buys and their recorded sells only. Remaining lot units
            are not current wallet balances. External transfers and pending
            trades are not reconstructed. A completed recorded lot does not
            prove profit or wallet readiness.
          </p>
          <label className="warmup-checkbox-choice" htmlFor={field}>
            <input
              id={field}
              type="checkbox"
              checked={earlier}
              onChange={(event) => setEarlier(event.target.checked)}
            />{' '}
            <span>
              Include earlier plan and wallet revisions with the same cycle,
              wallet and token.
            </span>
          </label>
          <Button variant="outline" disabled={busy} onClick={() => void read()}>
            Refresh cycle progress
          </Button>
          {busy && <output>Loading recorded cycle progress…</output>}
          {error && <p role="alert">{error}</p>}
          {result && (
            <>
              <p>
                {result.completedSteps}/{result.steps.length} wallet cycles have
                all included recorded lots sold. {result.activeApprovals} active
                approvals need recovery before further transactions.
              </p>
              <WarmupPerformance performance={result.performance} />
              {result.excludedBuys > 0 && (
                <p>
                  {result.excludedBuys} saved buys are outside this revision or
                  the current cycle, wallet and token configuration.
                </p>
              )}
              {plan.archived && (
                <p>Archived plan. Progress remains available for review.</p>
              )}
              <div className="overflow-x-auto">
                <table>
                  <caption>
                    Saved revision {plan.revision}.{' '}
                    {earlier
                      ? 'Earlier matching revisions included.'
                      : 'Current captured revisions only.'}
                  </caption>
                  <thead>
                    <tr>
                      <th>Cycle</th>
                      <th>Wallet / token</th>
                      <th>Recorded state</th>
                      <th>Buy lots</th>
                      <th>Remaining lot units</th>
                      {onReview && <th>Review</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {result.steps
                      .slice(page * 50, (page + 1) * 50)
                      .map((step) => (
                        <tr key={`${step.cycle}:${step.wallet}`}>
                          <td>{step.cycle}</td>
                          <td>
                            <div className="break-all">{step.wallet}</div>
                            <div className="break-all">{step.mint}</div>
                          </td>
                          <td>
                            {step.state}
                            {step.recoveryCount > 0 && (
                              <p>
                                Open approval recovery for this wallet. An
                                approval on another plan can also block it.
                              </p>
                            )}
                          </td>
                          <td>
                            {step.buyCount}
                            {step.historicalBuyCount > 0 && (
                              <p>{step.historicalBuyCount} earlier revisions</p>
                            )}
                          </td>
                          <td>
                            {step.decimals === null ? (
                              'No recorded buy'
                            ) : (
                              <>
                                {formatNativeBalance(
                                  step.remainingRaw,
                                  step.decimals,
                                )}
                                <small> Raw: {step.remainingRaw}</small>
                              </>
                            )}
                          </td>
                          {onReview && (
                            <td>
                              {(step.state === 'Not bought' ||
                                step.state === 'Tokens remaining') && (
                                <Button
                                  variant="outline"
                                  onClick={() => onReview(step)}
                                  aria-label={`Review ${step.state === 'Not bought' ? 'buy' : 'sell'} for cycle ${step.cycle}, wallet ${step.wallet}`}
                                >
                                  {step.state === 'Not bought'
                                    ? 'Review buy'
                                    : 'Review sell'}
                                </Button>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <p>
                Wallet cycles {page * 50 + 1} to{' '}
                {Math.min((page + 1) * 50, result.steps.length)} of{' '}
                {result.steps.length}
              </p>
              <Button
                variant="outline"
                disabled={page === 0}
                onClick={() => setPage((value) => value - 1)}
              >
                Previous cycles
              </Button>
              <Button
                variant="outline"
                disabled={(page + 1) * 50 >= result.steps.length}
                onClick={() => setPage((value) => value + 1)}
              >
                Next cycles
              </Button>
            </>
          )}
        </>
      )}
    </section>
  );
}
