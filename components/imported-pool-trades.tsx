'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './ui/button';
import type { PoolTrade, PoolTrades } from '@/lib/pool-trades';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import { PoolTradeMovementPanel } from './pool-trade-movement';
type Result = {
  id: string;
  revision: number;
  observations: PoolTrades[];
  executionAllowed: boolean;
  error?: string;
};
export function ImportedPoolTrades({
  project,
  pool,
  feedRunning,
  compact = false,
}: {
  project: ImportedTokenProject;
  pool: string;
  feedRunning: boolean;
  compact?: boolean;
}) {
  const [saved, setSaved] = useState<PoolTrades[]>([]),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const [selectedMovement, setSelectedMovement] = useState<{
    trade: PoolTrade;
    observedAt: string;
  } | null>(null);
  const accept = (data: Result) => {
    if (
      data.id !== project.id ||
      data.revision !== project.revision ||
      data.executionAllowed !== false ||
      !Array.isArray(data.observations) ||
      data.observations.length > 10 ||
      data.observations.some(
        (s) =>
          s.chain !== project.document.token.chain ||
          s.address !== project.document.token.address ||
          s.executionAllowed !== false ||
          s.trades.length > 100,
      )
    )
      throw new Error('Trade tape context mismatch.');
    setSaved(data.observations);
  };
  useEffect(() => {
    const c = new AbortController();
    pending.current = c;
    void fetch(
      `/api/imported-projects/trades?${new URLSearchParams({ id: project.id, revision: String(project.revision) })}`,
      { signal: c.signal, cache: 'no-store' },
    )
      .then(async (response) => {
        const data = (await response.json()) as Result;
        if (!response.ok)
          throw new Error(data.error || 'Saved trade tape unavailable.');
        if (
          data.id !== project.id ||
          data.revision !== project.revision ||
          data.executionAllowed !== false ||
          !Array.isArray(data.observations) ||
          data.observations.length > 10 ||
          data.observations.some(
            (s) =>
              s.chain !== project.document.token.chain ||
              s.address !== project.document.token.address ||
              s.executionAllowed !== false ||
              s.trades.length > 100,
          )
        )
          throw new Error('Trade tape context mismatch.');
        if (!c.signal.aborted) setSaved(data.observations);
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Saved trades unavailable.',
          );
      })
      .finally(() => {
        if (!c.signal.aborted) setBusy(false);
      });
    return () => pending.current?.abort();
  }, [
    project.id,
    project.revision,
    project.document.token.chain,
    project.document.token.address,
  ]);
  async function refresh() {
    if (busy || project.archived || feedRunning) return;
    const c = new AbortController();
    pending.current?.abort();
    pending.current = c;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/imported-projects/trades', {
        method: 'POST',
        signal: c.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: project.id,
          revision: project.revision,
          pool,
        }),
      });
      const data = (await response.json()) as Result;
      if (!response.ok)
        throw new Error(data.error || 'Pool trade read unavailable.');
      if (!c.signal.aborted) accept(data);
    } catch (e) {
      if (!c.signal.aborted)
        setError(e instanceof Error ? e.message : 'Pool trades unavailable.');
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  const snapshot = saved.find((s) => s.pool === pool);
  const movementContext = useMemo(
    () =>
      selectedMovement && selectedMovement.observedAt === snapshot?.observedAt
        ? {
            projectId: project.id,
            revision: project.revision,
            pool,
            mint: project.document.token.address,
            decimals: project.document.token.decimals,
            tapeObservedAt: selectedMovement.observedAt,
            trade: selectedMovement.trade,
          }
        : null,
    [
      selectedMovement,
      snapshot?.observedAt,
      project.id,
      project.revision,
      pool,
      project.document.token.address,
      project.document.token.decimals,
    ],
  );
  const explorer =
    project.document.token.chain === 'Solana'
      ? 'https://solscan.io/tx/'
      : project.document.token.chain === 'Ethereum'
        ? 'https://etherscan.io/tx/'
        : project.document.token.chain === 'Base'
          ? 'https://basescan.org/tx/'
          : 'https://bscscan.com/tx/';
  return (
    <section
      aria-label="Selected pool trade tape"
      className={`imported-pool-trade-tape${compact ? ' imported-pool-trade-tape--compact' : ''}`}
    >
      <h4>Recent pool trades</h4>
      <Button
        variant="outline"
        disabled={busy || project.archived || feedRunning}
        onClick={() => void refresh()}
      >
        {busy ? 'Loading pool trades…' : 'Refresh pool trades'}
      </Button>
      <details className="pool-trade-coverage">
        <summary>Trade tape coverage</summary>
        <p>
          Provider-reported swaps for this pool, with direction relative to its
          base token. Retains the latest 100 records for each of up to 10
          selected pools. Refresh replaces that pool&apos;s saved tape. Manual
          reads only; stop the market feed before refreshing. This is a limited
          provider window, not complete tick coverage, our execution receipts,
          wallet ownership or verified trader activity.
        </p>
      </details>
      {error && <p role="alert">{error}</p>}
      {snapshot ? (
        <>
          <p>
            {snapshot.trades.length} retained of {snapshot.returnedCount}{' '}
            returned · observed {new Date(snapshot.observedAt).toLocaleString()}{' '}
            · {snapshot.source} · captured project r{snapshot.projectRevision}
          </p>
          <p>
            Quote token:{' '}
            <code className="warmup-address">{snapshot.quote}</code>
          </p>
          {snapshot.projectRevision !== project.revision && (
            <p>
              Project metadata changed since this read. These remain historical
              provider records.
            </p>
          )}
          {snapshot.trades.length ? (
            <div className="pool-trade-table-scroll">
              <table className="project-table">
                <caption>
                  Provider pool trades, newest first. USD values rounded for
                  display; expand Exact values for the original strings.
                </caption>
                <thead>
                  <tr>
                    {[
                      'Time',
                      'Side',
                      'Token amount',
                      'Quote amount',
                      'Token price USD',
                      'Volume USD',
                      'Sender',
                      'Transaction',
                    ].map((h) => (
                      <th
                        key={h}
                        className={
                          [
                            'Time',
                            'Sender',
                            'Token amount',
                            'Quote amount',
                            'Token price USD',
                          ].includes(h)
                            ? 'pool-trade-extra-column'
                            : undefined
                        }
                      >
                        {compact && h === 'Transaction'
                          ? 'Sender / Tx'
                          : compact && h === 'Side'
                            ? 'Side / time'
                            : h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {snapshot.trades.map((t) => (
                    <tr key={t.id} data-side={t.side}>
                      <td className="pool-trade-extra-column">
                        <time
                          dateTime={t.timestamp}
                          title={`${t.timestamp} · block ${t.block}`}
                        >
                          {compact
                            ? new Date(t.timestamp).toLocaleTimeString(
                                undefined,
                                { hour: '2-digit', minute: '2-digit' },
                              )
                            : new Date(t.timestamp).toLocaleString()}
                        </time>
                        {!compact && <small>Block {t.block}</small>}
                      </td>
                      <td className="pool-trade-side">
                        {t.side}
                        {compact && (
                          <small>
                            <time dateTime={t.timestamp}>
                              {new Date(t.timestamp).toLocaleTimeString(
                                undefined,
                                { hour: '2-digit', minute: '2-digit' },
                              )}
                            </time>
                          </small>
                        )}
                      </td>
                      <td className="pool-trade-extra-column">
                        {t.tokenAmount}
                      </td>
                      <td className="pool-trade-extra-column">
                        {t.quoteAmount}
                      </td>
                      <td
                        className="pool-trade-extra-column"
                        title={t.priceUsd}
                      >
                        {Number(t.priceUsd).toLocaleString(undefined, {
                          maximumSignificantDigits: 8,
                        })}
                      </td>
                      <td title={t.volumeUsd}>
                        {Number(t.volumeUsd).toLocaleString(undefined, {
                          maximumSignificantDigits: 8,
                        })}
                      </td>
                      <td className="pool-trade-extra-column">
                        <code title={t.sender}>
                          {t.sender.slice(0, 6)}…{t.sender.slice(-4)}
                        </code>
                      </td>
                      <td>
                        {compact && (
                          <code title={t.sender}>
                            {t.sender.slice(0, 6)}…{t.sender.slice(-4)}
                          </code>
                        )}
                        <a
                          href={`${explorer}${t.transaction}`}
                          target="_blank"
                          rel="noreferrer"
                          title={t.transaction}
                          aria-label={`View transaction ${t.transaction}`}
                        >
                          {compact ? 'Tx' : 'View transaction'}
                        </a>
                        <details>
                          <summary>Exact values</summary>
                          <p>
                            Time: {t.timestamp}. Block: {t.block}
                          </p>
                          <p>Token amount: {t.tokenAmount}</p>
                          <p>Quote amount: {t.quoteAmount}</p>
                          <p>Price USD: {t.priceUsd}</p>
                          <p>Volume USD: {t.volumeUsd}</p>
                          <p>
                            Sender:{' '}
                            <code className="warmup-address">{t.sender}</code>
                          </p>
                        </details>
                        {project.document.token.chain === 'Solana' && (
                          <Button
                            variant="outline"
                            disabled={
                              busy ||
                              feedRunning ||
                              project.archived ||
                              snapshot.projectRevision !== project.revision
                            }
                            aria-label={`Inspect wallet movement ${t.transaction}`}
                            onClick={() =>
                              setSelectedMovement({
                                trade: t,
                                observedAt: snapshot.observedAt,
                              })
                            }
                          >
                            {compact ? 'Inspect' : 'Inspect wallet movement'}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>
              No trades returned. This does not establish that the pool has
              never traded.
            </p>
          )}
          {movementContext && (
            <PoolTradeMovementPanel
              key={`${project.id}:${project.revision}:${pool}:${snapshot.observedAt}:${movementContext.trade.id}`}
              context={movementContext}
              onClose={() => setSelectedMovement(null)}
            />
          )}
        </>
      ) : (
        !busy && <p>No saved trade tape for this pool.</p>
      )}
    </section>
  );
}
