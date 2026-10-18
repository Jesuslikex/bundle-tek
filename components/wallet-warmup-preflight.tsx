'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { WarmupPreflight } from '@/lib/wallet-warmup-preflight';
import { readPanelJson } from './read-panel-json';
import styles from './wallet-warmup.module.css';
export function WalletWarmupPreflight({
  id,
  revision,
}: {
  id: string;
  revision: number;
}) {
  const [report, setReport] = useState<WarmupPreflight | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [expired, setExpired] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!report) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(report.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [report]);
  async function inspect() {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    setError('');
    setReport(null);
    setExpired(false);
    const timeout = setTimeout(() => {
      if (c.signal.aborted) return;
      c.abort();
      setBusy(false);
      setError(
        'Preflight took too long. Check your connection and try checking again.',
      );
    }, 30_000);
    try {
      const response = await fetch('/api/wallet-workspace/warmup/preflight', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: c.signal,
        body: JSON.stringify({ id, revision }),
      });
      const data = (await readPanelJson(
        response,
        'Warmup preflight unavailable. Try checking again.',
      )) as {
        id?: string;
        revision?: number;
        report?: WarmupPreflight;
        error?: string;
      };
      if (!data || typeof data !== 'object')
        throw new Error('Warmup preflight unavailable. Try checking again.');
      if (!response.ok) throw new Error(data.error || 'Preflight unavailable.');
      if (
        data.id !== id ||
        data.revision !== revision ||
        !data.report ||
        data.report.executionAllowed !== false
      )
        throw new Error('Preflight revision mismatch.');
      if (!c.signal.aborted) setReport(data.report);
    } catch (e) {
      if (!c.signal.aborted)
        setError(e instanceof Error ? e.message : 'Preflight unavailable.');
    } finally {
      clearTimeout(timeout);
      if (!c.signal.aborted) setBusy(false);
    }
  }
  return (
    <div>
      <Button variant="outline" disabled={busy} onClick={inspect}>
        {busy ? 'Checking preflight…' : 'Check warmup preflight'}
      </Button>
      {busy && (
        <>
          <output aria-live="polite">
            Reading preflight only. No wallet unlock, signature or transaction
            is requested.
          </output>
          <Button
            variant="ghost"
            onClick={() => {
              controller.current?.abort();
              setBusy(false);
              setError('Preflight cancelled. You can try checking again.');
            }}
          >
            Cancel preflight
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {report && (
        <section
          className={styles.result}
          aria-label="Warmup preflight observations"
        >
          <h5>{report.status}</h5>
          {expired && (
            <p role="alert">
              Preflight observations expired. Check warmup preflight again
              before continuing.
            </p>
          )}
          <p>
            Required per wallet: {report.requiredPerWallet} {report.currency},
            including your fee reserve.
          </p>
          {report.issues.map((issue) => (
            <p key={issue}>{issue}</p>
          ))}
          {report.wallets.map((w) => (
            <div key={w.address}>
              {report.wallets.length > 1 && (
                <strong>
                  {w.address.slice(0, 4)}…{w.address.slice(-4)}
                </strong>
              )}
              <dl className={styles.balanceGrid}>
                <div>
                  <dt>Balance</dt>
                  <dd>
                    {w.amount ?? 'Unknown'} {report.currency}
                  </dd>
                </div>
                <div>
                  <dt>Shortfall</dt>
                  <dd>
                    {w.shortfall ?? 'Unknown'} {report.currency}
                  </dd>
                </div>
              </dl>
            </div>
          ))}
          <p className={styles.help}>Read-only check. No trades are started.</p>
          <details className={styles.technical}>
            <summary>Technical details</summary>
            <p>Saved revision {revision}</p>
            {report.wallets.map((w) => (
              <p key={w.address} className="warmup-address">
                Wallet: {w.address}
              </p>
            ))}
            {report.tokens.map((t) => (
              <p key={t.address} className="warmup-address">
                {t.address}
                <br />
                {t.error ??
                  `${t.name} (${t.symbol}), ${t.decimals} decimals. Source: ${t.source}.`}
              </p>
            ))}
            <small>
              Observed {new Date(report.observedAt).toLocaleString()}. Refresh
              after {new Date(report.expiresAt).toLocaleString()}.{' '}
              {report.snapshot &&
                `Balances from ${report.snapshot.source} at block/slot ${report.snapshot.blockNumber}.`}{' '}
              {report.limitations}
            </small>
          </details>
        </section>
      )}
    </div>
  );
}
