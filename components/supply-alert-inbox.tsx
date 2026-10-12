'use client';
import { requestImportedWalletReview } from '@/lib/imported-wallet-review-events';
import { requestSupplyAlertChart } from '@/lib/supply-alert-chart-events';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { SupplyMovementEvidencePanel } from './supply-movement-evidence';
import type { SupplyHistoryRow } from '@/lib/supply-history';
import {
  matchesSupplyAlert,
  type SupplyAlertFilter,
} from '@/lib/supply-alert-filter';

export function SupplyAlertInbox({
  projectId,
  revision,
  scope,
  items,
}: {
  projectId: string;
  revision: number;
  scope: string;
  items: SupplyHistoryRow[];
}) {
  const [walletReviewError, setWalletReviewError] = useState('');
  const [reviewed, setReviewed] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [showReviewed, setShowReviewed] = useState(true);
  const pending = useRef<AbortController | null>(null);
  const [filter, setFilter] = useState<SupplyAlertFilter>({
    wallet: '',
    group: 'all',
    direction: 'all',
    minimum: '',
  });
  const load = useCallback(
    async (sequence?: number) => {
      if (pending.current) return;
      const controller = new AbortController();
      pending.current = controller;
      setBusy(true);
      setError('');
      try {
        const c = { id: projectId, revision, scope };
        const response = await fetch(
          '/api/imported-projects/supply-alert-review' +
            (sequence === undefined
              ? '?' + new URLSearchParams({ ...c, revision: String(revision) })
              : ''),
          {
            method: sequence === undefined ? 'GET' : 'POST',
            cache: 'no-store',
            headers:
              sequence === undefined
                ? undefined
                : { 'content-type': 'application/json' },
            body:
              sequence === undefined
                ? undefined
                : JSON.stringify({ ...c, sequence }),
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(15000),
            ]),
          },
        );
        const result = (await response.json()) as {
          id: string;
          revision: number;
          scope: string;
          reviewedThrough: number;
          error?: string;
        };
        if (!response.ok)
          throw new Error(result.error || 'Alert review unavailable.');
        if (
          result.id !== projectId ||
          result.revision !== revision ||
          result.scope !== scope ||
          !Number.isSafeInteger(result.reviewedThrough) ||
          result.reviewedThrough < 0
        )
          throw new Error('Alert review context differs.');
        if (!controller.signal.aborted) setReviewed(result.reviewedThrough);
      } catch (e) {
        if (!controller.signal.aborted) {
          setReviewed(null);
          setError(
            e instanceof Error ? e.message : 'Alert review unavailable.',
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          pending.current = null;
          setBusy(false);
        }
      }
    },
    [projectId, revision, scope],
  );
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(timer);
      pending.current?.abort();
      pending.current = null;
    };
  }, [load]);
  const latest = items[0]?.sequence ?? 0;
  const alerts = items.flatMap((row) =>
    row.document.alerts.map((alert) => ({ row, alert })),
  );
  const unreviewed =
    reviewed === null
      ? null
      : alerts.filter((a) => a.row.sequence > reviewed).length;
  const wallets = [
    ...new Set(
      items.flatMap((row) =>
        row.document.snapshot.wallets.map((w) => w.address),
      ),
    ),
  ];
  let visible = alerts,
    filterError = '';
  try {
    visible = alerts.filter(({ row, alert }) =>
      matchesSupplyAlert(alert, row.document.snapshot.decimals, filter),
    );
  } catch (e) {
    filterError =
      e instanceof Error ? e.message : 'Movement filter unavailable.';
  }
  visible = visible.filter(
    (a) => showReviewed || reviewed === null || a.row.sequence > reviewed,
  );
  return (
    <section aria-label="Wallet movement alert inbox">
      <p>
        {unreviewed === null
          ? 'Review status unavailable until loaded.'
          : `${unreviewed} unreviewed movements in loaded history.`}
      </p>
      <div className="wallet-roster-actions">
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          Reload alert review status
        </Button>
        <Button
          variant="outline"
          disabled={busy || reviewed === null || !latest || reviewed >= latest}
          onClick={() => void load(latest)}
        >
          Mark alerts through observation #{latest} reviewed
        </Button>
        <Button
          variant="outline"
          disabled={busy || !reviewed}
          onClick={() => void load(0)}
        >
          Reset alert review marker
        </Button>
      </div>
      <p>
        The review marker includes all earlier observations in this watchlist,
        including history not loaded here. It does not change or remove saved
        evidence.
      </p>
      <label>
        <input
          type="checkbox"
          checked={showReviewed}
          onChange={(e) => setShowReviewed(e.target.checked)}
        />{' '}
        Show reviewed movements
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="wallet-roster-actions">
        <label>
          Movement wallet{' '}
          <select
            aria-label="Movement wallet"
            value={filter.wallet}
            onChange={(e) => setFilter({ ...filter, wallet: e.target.value })}
          >
            <option value="">All watched wallets</option>
            {wallets.map((w) => (
              <option key={w} value={w}>
                {w.slice(0, 6)}…{w.slice(-4)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Movement group{' '}
          <select
            aria-label="Movement group"
            value={filter.group}
            onChange={(e) =>
              setFilter({
                ...filter,
                group: e.target.value as SupplyAlertFilter['group'],
              })
            }
          >
            <option value="all">All groups</option>
            <option value="team">Team controlled</option>
            <option value="external">External</option>
            <option value="pool">Pool</option>
          </select>
        </label>
        <label>
          Movement direction{' '}
          <select
            aria-label="Movement direction"
            value={filter.direction}
            onChange={(e) =>
              setFilter({
                ...filter,
                direction: e.target.value as SupplyAlertFilter['direction'],
              })
            }
          >
            <option value="all">All directions</option>
            <option value="increase">Increases</option>
            <option value="decrease">Decreases</option>
          </select>
        </label>
        <label>
          Minimum movement (tokens){' '}
          <input
            aria-label="Minimum movement (tokens)"
            inputMode="decimal"
            maxLength={277}
            value={filter.minimum}
            onChange={(e) => setFilter({ ...filter, minimum: e.target.value })}
          />
        </label>
        <Button
          variant="outline"
          onClick={() => {
            setFilter({
              wallet: '',
              group: 'all',
              direction: 'all',
              minimum: '',
            });
            setShowReviewed(true);
          }}
        >
          Clear movement filters
        </Button>
      </div>
      {filterError && (
        <p role="alert">{filterError} Movement filters are not applied.</p>
      )}
      <p aria-live="polite">
        Showing {visible.length} of {alerts.length} movements in loaded history.
        Review-through applies to every earlier movement, including filtered
        results.
      </p>
      {!visible.length && (
        <p>
          No loaded movements match these filters. Older history may contain
          more movements.
        </p>
      )}
      {walletReviewError && <p role="alert">{walletReviewError}</p>}
      <div className="supply-alert-list">
        {visible.map(({ row, alert: a }) => (
          <article key={`${row.id}:${a.address}`}>
            <strong>
              {a.group} wallet balance {a.direction} · {a.amount} tokens
            </strong>
            <p>
              {reviewed === null
                ? 'Review status unknown'
                : row.sequence <= reviewed
                  ? 'Reviewed'
                  : 'Unreviewed'}
            </p>
            <code className="warmup-address">{a.address}</code>
            <small>
              {new Date(row.document.previousObservedAt!).toLocaleString()} to{' '}
              {new Date(row.document.snapshot.observedAt).toLocaleString()} ·
              observation #{row.sequence}
            </small>
            <div className="wallet-roster-actions">
              <Button
                variant="outline"
                aria-label={`Inspect alert on chart ${a.address}`}
                onClick={() =>
                  setWalletReviewError(
                    requestSupplyAlertChart({
                      projectId,
                      revision,
                      mint: row.document.snapshot.mint,
                      wallet: a.address,
                      from: row.document.previousObservedAt!,
                      to: row.document.snapshot.observedAt,
                    }) ?? '',
                  )
                }
              >
                Inspect on chart
              </Button>
              {(['Buy', 'Sell'] as const).map((side) => (
                <Button
                  key={side}
                  variant="outline"
                  aria-label={`Review alert wallet ${side.toLowerCase()} ${a.address}`}
                  onClick={() =>
                    setWalletReviewError(
                      requestImportedWalletReview({
                        projectId,
                        revision,
                        mint: row.document.snapshot.mint,
                        wallet: a.address,
                        side,
                      }) ?? '',
                    )
                  }
                >
                  {side} review
                </Button>
              ))}
            </div>
            <small>
              Review only. Fresh balances and signing approval are required for
              a trade.
            </small>
            <SupplyMovementEvidencePanel
              projectId={projectId}
              revision={revision}
              row={row}
              wallet={a.address}
            />
          </article>
        ))}
      </div>
    </section>
  );
}
