'use client';
import { useEffect, useRef, useState } from 'react';
import {
  validatedAutoSellOutcomeReference,
  type AutoSellOutcomeReference,
} from '@/lib/auto-sell-outcome-reference';
import { savedAutoSellOutcome } from '@/lib/auto-sell-outcome';
import { readPanelJson } from './read-panel-json';
import { Button } from './ui/button';
import styles from './auto-sell-outcome-read.module.css';

export function AutoSellOutcomeRead({
  reference,
  projectId,
  mint,
}: {
  reference: AutoSellOutcomeReference;
  projectId: string;
  mint: string;
}) {
  let ref: AutoSellOutcomeReference;
  try {
    ref = validatedAutoSellOutcomeReference(reference);
    if (ref.projectId !== projectId || ref.mint !== mint) throw Error();
  } catch {
    return (
      <p>
        Original outcome lookup context is unavailable. Open preparation
        history.
      </p>
    );
  }
  return <OutcomeRead key={JSON.stringify(ref)} reference={ref} />;
}
function OutcomeRead({
  reference: ref,
}: {
  reference: AutoSellOutcomeReference;
}) {
  const [result, setResult] = useState<ReturnType<
    typeof savedAutoSellOutcome
  > | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function read() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15000),
    ]);
    setBusy(true);
    setResult(null);
    setError('');
    try {
      const response = await fetch(
        `/api/imported-projects/signing?projectId=${encodeURIComponent(ref.projectId)}&intentId=${encodeURIComponent(ref.intentId)}`,
        { method: 'GET', cache: 'no-store', signal },
      );
      const body = await readPanelJson(
        response,
        'Saved outcome lookup unavailable.',
      );
      if (!response.ok) throw Error('Saved outcome lookup unavailable.');
      const value = savedAutoSellOutcome(body, ref);
      if (signal.aborted) throw Error('Lookup ended.');
      if (pending.current === controller && !controller.signal.aborted)
        setResult(value);
    } catch {
      if (pending.current === controller && !controller.signal.aborted)
        setError(
          'Saved outcome unavailable or its original context differs. Use preparation history; this lookup never resends a transaction.',
        );
    } finally {
      if (pending.current === controller && !controller.signal.aborted)
        setBusy(false);
    }
  }
  const labels: Record<string, string> = {
    awaiting_signature: 'Awaiting signature in saved history',
    signed: 'Signature recorded; submission not established',
    submitted: 'Submission recorded; receipt proof not loaded',
    cancelled: 'Approval cancelled in saved history',
    failed: 'Failure recorded; inspect preparation history',
    finalized: 'Finalized status recorded; receipt proof not loaded',
  };
  return (
    <details className={styles.readout}>
      <summary>Find this transaction in saved history</summary>
      <p>
        Reads only the original approval record. It does not check the chain,
        load a finalized receipt, change session counters, sign or resend.
      </p>
      <dl>
        <div>
          <dt>Original preparation</dt>
          <dd>
            <code>{ref.preparationId}</code>
          </dd>
        </div>
        <div>
          <dt>Original approval</dt>
          <dd>
            <code>{ref.intentId}</code>
          </dd>
        </div>
        <div>
          <dt>Wallet</dt>
          <dd>
            <code>{ref.wallet}</code>
          </dd>
        </div>
      </dl>
      <a
        href={`https://solscan.io/tx/${ref.signature}`}
        target="_blank"
        rel="noreferrer"
      >
        View original local signature in explorer
      </a>
      <Button variant="outline" disabled={busy} onClick={() => void read()}>
        {busy
          ? 'Reading saved outcome…'
          : result
            ? 'Refresh saved outcome'
            : 'Read saved outcome'}
      </Button>
      {busy && (
        <Button
          variant="outline"
          onClick={() => {
            pending.current?.abort();
            setBusy(false);
            setResult(null);
            setError('Lookup cancelled. No transaction was changed.');
          }}
        >
          Cancel lookup
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      {result && (
        <output>
          <strong>{labels[result.state]}</strong>
          <span>
            Saved update:{' '}
            <time dateTime={new Date(result.updatedAt).toISOString()}>
              {new Date(result.updatedAt).toISOString()}
            </time>
            .
          </span>
          <span>
            Recorded status alone is not receipt verification. Submitted or
            unknown amounts remain accounted for.
          </span>
        </output>
      )}
    </details>
  );
}
