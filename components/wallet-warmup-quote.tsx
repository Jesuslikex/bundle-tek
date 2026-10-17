'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { WarmupSwapQuote } from '@/lib/warmup-swap-quote';
import { readPanelJson } from './read-panel-json';
export function WalletWarmupQuote({
  id,
  revision,
  cycles,
}: {
  id: string;
  revision: number;
  cycles: number;
}) {
  const cycleId = useId();
  const [cycle, setCycle] = useState(1);
  const [quote, setQuote] = useState<WarmupSwapQuote | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [expired, setExpired] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!quote) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(quote.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [quote]);
  async function inspect() {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    setError('');
    setQuote(null);
    setExpired(false);
    try {
      const response = await fetch('/api/wallet-workspace/warmup/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: c.signal,
        body: JSON.stringify({ id, revision, cycle }),
      });
      const data = (await readPanelJson(
        response,
        'Warmup quote unavailable. Try quoting again.',
      )) as {
        id?: string;
        revision?: number;
        quote?: WarmupSwapQuote;
        error?: string;
      };
      if (!data || typeof data !== 'object')
        throw new Error('Warmup quote unavailable. Try quoting again.');
      if (!response.ok) throw new Error(data.error || 'Quote unavailable.');
      if (
        data.id !== id ||
        data.revision !== revision ||
        data.quote?.executionAllowed !== false ||
        data.quote.cycle !== cycle
      )
        throw new Error('Quote revision mismatch.');
      if (!c.signal.aborted) setQuote(data.quote);
    } catch (e) {
      if (!c.signal.aborted)
        setError(e instanceof Error ? e.message : 'Quote unavailable.');
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  return (
    <div>
      <label htmlFor={cycleId}>Warmup buy cycle</label>
      <select
        id={cycleId}
        value={cycle}
        onChange={(e) => {
          controller.current?.abort();
          setCycle(Number(e.target.value));
          setQuote(null);
          setError('');
          setBusy(false);
          setExpired(false);
        }}
      >
        {Array.from({ length: cycles }, (_, i) => (
          <option value={i + 1} key={i}>
            Cycle {i + 1}
          </option>
        ))}
      </select>
      <Button disabled={busy} variant="outline" onClick={inspect}>
        {busy ? 'Quoting buy…' : 'Quote warmup buy'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {quote && (
        <section aria-label="Warmup swap quote">
          <p>
            {expired
              ? 'Expired. Refresh before reviewing.'
              : `Quote via ${quote.router}, 0.5% slippage.`}
          </p>
          <p className="warmup-address">Token: {quote.outputMint}</p>
          <p>
            Input: {quote.inAmount} lamports. Quoted output: {quote.outAmount}{' '}
            token atomic units. Minimum output: {quote.minimumOutAmount}.
          </p>
          <small>
            {quote.limitations} Expires{' '}
            {new Date(quote.expiresAt).toLocaleString()}.
          </small>
        </section>
      )}
    </div>
  );
}
