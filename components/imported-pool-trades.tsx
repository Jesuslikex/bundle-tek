'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import type { PoolTrades } from '@/lib/pool-trades';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
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
}: {
  project: ImportedTokenProject;
  pool: string;
  feedRunning: boolean;
}) {
  const [saved, setSaved] = useState<PoolTrades[]>([]),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
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
  const explorer =
    project.document.token.chain === 'Solana'
      ? 'https://solscan.io/tx/'
      : project.document.token.chain === 'Ethereum'
        ? 'https://etherscan.io/tx/'
        : project.document.token.chain === 'Base'
          ? 'https://basescan.org/tx/'
          : 'https://bscscan.com/tx/';
  return (
    <section aria-label="Selected pool trade tape">
      <h4>Recent pool trades</h4>
      <Button
        variant="outline"
        disabled={busy || project.archived || feedRunning}
        onClick={() => void refresh()}
      >
        {busy ? 'Loading pool trades…' : 'Refresh pool trades'}
      </Button>
      <p>
        Provider-reported swaps for this pool, with direction relative to its
        base token. Retains the latest 100 records for each of up to 10 selected
        pools. Refresh replaces that pool&apos;s saved tape. Manual reads only;
        stop the market feed before refreshing. This is a limited provider
        window, not complete tick coverage, our execution receipts, wallet
        ownership or verified trader activity.
      </p>
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
            <div style={{ overflowX: 'auto', maxHeight: 360 }}>
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
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {snapshot.trades.map((t) => (
                    <tr key={t.id}>
                      <td>
                        {new Date(t.timestamp).toLocaleString()}
                        <small>Block {t.block}</small>
                      </td>
                      <td>{t.side}</td>
                      <td>{t.tokenAmount}</td>
                      <td>{t.quoteAmount}</td>
                      <td title={t.priceUsd}>
                        {Number(t.priceUsd).toLocaleString(undefined, {
                          maximumSignificantDigits: 8,
                        })}
                      </td>
                      <td title={t.volumeUsd}>
                        {Number(t.volumeUsd).toLocaleString(undefined, {
                          maximumSignificantDigits: 8,
                        })}
                      </td>
                      <td>
                        <code title={t.sender}>
                          {t.sender.slice(0, 6)}…{t.sender.slice(-4)}
                        </code>
                      </td>
                      <td>
                        <a
                          href={`${explorer}${t.transaction}`}
                          target="_blank"
                          rel="noreferrer"
                          title={t.transaction}
                        >
                          View transaction
                        </a>
                        <details>
                          <summary>Exact values</summary>
                          <p>Token amount: {t.tokenAmount}</p>
                          <p>Quote amount: {t.quoteAmount}</p>
                          <p>Price USD: {t.priceUsd}</p>
                          <p>Volume USD: {t.volumeUsd}</p>
                          <p>
                            Sender:{' '}
                            <code className="warmup-address">{t.sender}</code>
                          </p>
                        </details>
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
        </>
      ) : (
        !busy && <p>No saved trade tape for this pool.</p>
      )}
    </section>
  );
}
