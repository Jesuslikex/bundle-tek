'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { WarmupPreflight } from '@/lib/wallet-warmup-preflight';
import { readPanelJson } from './read-panel-json';
export function WalletWarmupPreflight({
  id,
  revision,
}: {
  id: string;
  revision: number;
}) {
  const [report, setReport] = useState<WarmupPreflight | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function inspect() {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    setError('');
    setReport(null);
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
      if (!c.signal.aborted) setBusy(false);
    }
  }
  return (
    <div>
      <Button variant="outline" disabled={busy} onClick={inspect}>
        {busy ? 'Checking preflight…' : 'Check warmup preflight'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {report && (
        <section aria-label="Warmup preflight observations">
          <h5>
            {report.status} · saved revision {revision}
          </h5>
          <p>
            Required per wallet: {report.requiredPerWallet} {report.currency},
            including your fee reserve.
          </p>
          {report.issues.map((issue) => (
            <p key={issue}>{issue}</p>
          ))}
          {report.wallets.map((w) => (
            <p key={w.address} className="warmup-address">
              {w.address}
              <br />
              Balance: {w.amount ?? 'Unknown'} {report.currency}. Budget
              shortfall: {w.shortfall ?? 'Unknown'} {report.currency}.
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
        </section>
      )}
    </div>
  );
}
