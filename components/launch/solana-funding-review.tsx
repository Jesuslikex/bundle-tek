'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { SolanaFundingBatch } from '@/lib/solana-funding';
import type { SolanaTokenFundingBatch } from '@/lib/solana-token-funding';
type Batch = SolanaFundingBatch | SolanaTokenFundingBatch;
export function SolanaFundingReview({
  id,
  revision,
  enabled,
}: {
  id: string;
  revision: number;
  enabled: boolean;
}) {
  const [batch, setBatch] = useState<Batch | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [expired, setExpired] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!batch) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(batch.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [batch]);
  async function prepare() {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    setError('');
    setBatch(null);
    setExpired(false);
    try {
      const response = await fetch('/api/funding/fees', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: c.signal,
        body: JSON.stringify({ id, revision, action: 'prepare-solana' }),
      });
      const data = (await response.json()) as {
        id?: string;
        revision?: number;
        batch?: Batch;
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || 'Preparation unavailable.');
      if (
        data.id !== id ||
        data.revision !== revision ||
        data.batch?.executionAllowed !== false ||
        data.batch.signed !== false ||
        data.batch.chain !== 'Solana'
      )
        throw new Error('Funding revision mismatch.');
      if (!c.signal.aborted) setBatch(data.batch);
    } catch (e) {
      if (!c.signal.aborted)
        setError(e instanceof Error ? e.message : 'Preparation unavailable.');
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  function download() {
    if (!batch || Date.parse(batch.expiresAt) <= Date.now()) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ id, revision, ...batch }, null, 2)], {
        type: 'application/json',
      }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `funding-${id}-r${revision}-solana-unsigned.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section
      className="wallet-holdings-panel"
      aria-label="Solana funding preparation"
    >
      <h3>Solana funding preparation</h3>
      <p className="source-note">
        Immediate saved wallet drafts only. Native SOL or an exact standard SPL
        token asset. Review unsigned transfers after balance, fee, rent and
        simulation checks. No signing or sending.
      </p>
      <Button disabled={!enabled || busy} onClick={prepare}>
        {busy
          ? 'Preparing Solana transfers…'
          : 'Prepare unsigned Solana funding'}
      </Button>
      {!enabled && (
        <p>Save the current active draft before preparing transfers.</p>
      )}
      {error && (
        <p role="alert" className="draft-error">
          {error}
        </p>
      )}
      {batch && (
        <>
          <p>
            {batch.transactions.length} transfers · {batch.total}{' '}
            {batch.currency} · quoted fees {batch.fees} SOL · new token account
            rent {batch.accountRent} SOL · funder rent reserve{' '}
            {batch.rentReserve} SOL · required {batch.required} SOL.
          </p>
          {batch.assetAddress && (
            <p className="warmup-address">Mint: {batch.assetAddress}</p>
          )}
          <p>{batch.limitations}</p>
          <p className="warmup-address">
            Blockhash {batch.blockhash}. Last valid height{' '}
            {batch.lastValidBlockHeight}. Source: {batch.source}, slot{' '}
            {batch.slot}.
          </p>
          <p>
            {expired
              ? 'Expired. Prepare again.'
              : `Refresh by ${new Date(batch.expiresAt).toLocaleString()}.`}
          </p>
          <Button variant="outline" disabled={expired} onClick={download}>
            Export unsigned Solana JSON
          </Button>
          <details>
            <summary>Inspect unsigned Solana transaction fields</summary>
            <pre style={{ overflow: 'auto', maxHeight: 300 }}>
              {JSON.stringify(batch.transactions, null, 2)}
            </pre>
          </details>
        </>
      )}
    </section>
  );
}
