'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import type { TrackedWallet } from '@/lib/tracked-wallet';
import type { WarmupHistory } from '@/lib/wallet-warmup';
type Saved = {
  snapshot: WarmupHistory | null;
  capturedUpdatedAt: string | null;
  currentUpdatedAt: string;
  stale: boolean;
  executionAllowed: boolean;
  error?: string;
};
export function EvmTrackedWallet({ wallet }: { wallet: TrackedWallet }) {
  const [saved, setSaved] = useState<Saved | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const query = {
    address: wallet.address,
    network: wallet.network,
    expectedUpdatedAt: wallet.updatedAt,
  };
  const accept = (data: Saved) => {
    if (
      data.executionAllowed !== false ||
      data.currentUpdatedAt !== wallet.updatedAt ||
      (data.snapshot &&
        (data.snapshot.chain !== wallet.network ||
          data.snapshot.address !== wallet.address))
    )
      throw new Error('EVM snapshot context mismatch.');
    setSaved(data);
  };
  useEffect(() => {
    const c = new AbortController();
    pending.current = c;
    void fetch(
      `/api/tracker/evm?${new URLSearchParams({ address: wallet.address, network: wallet.network, expectedUpdatedAt: wallet.updatedAt })}`,
      { signal: c.signal, cache: 'no-store' },
    )
      .then(async (response) => {
        const data = (await response.json()) as Saved;
        if (!response.ok)
          throw new Error(data.error || 'Saved EVM snapshot unavailable.');
        if (
          data.executionAllowed !== false ||
          data.currentUpdatedAt !== wallet.updatedAt ||
          (data.snapshot &&
            (data.snapshot.chain !== wallet.network ||
              data.snapshot.address !== wallet.address))
        )
          throw new Error('EVM snapshot context mismatch.');
        if (!c.signal.aborted) setSaved(data);
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Saved EVM snapshot unavailable.',
          );
      })
      .finally(() => {
        if (!c.signal.aborted) setBusy(false);
      });
    return () => pending.current?.abort();
  }, [wallet.address, wallet.network, wallet.updatedAt]);
  async function refresh() {
    if (busy || wallet.archived) return;
    const c = new AbortController();
    pending.current?.abort();
    pending.current = c;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/tracker/evm', {
        method: 'POST',
        signal: c.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(query),
      });
      const data = (await response.json()) as Saved;
      if (!response.ok)
        throw new Error(data.error || 'EVM observation unavailable.');
      if (!c.signal.aborted) accept(data);
    } catch (e) {
      if (!c.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'EVM observation unavailable.',
        );
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  const snapshot = saved?.snapshot;
  return (
    <section aria-label="Saved EVM tracker snapshot">
      <h3>Native balance and account nonce</h3>
      <p>
        Opening this view reads the saved snapshot. Refresh explicitly to read
        the network provider. The latest observation is retained.
      </p>
      <Button
        variant="outline"
        disabled={busy || wallet.archived}
        onClick={() => void refresh()}
      >
        {busy ? 'Reading snapshot…' : 'Refresh EVM snapshot'}
      </Button>
      {wallet.archived && (
        <p>
          Archived address. Saved observations remain readable; restore it to
          refresh.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {saved && !snapshot && <p>No EVM snapshot saved.</p>}
      {snapshot && (
        <>
          {saved?.stale && (
            <p>
              Wallet metadata changed since this read. This remains a historical
              observation.
            </p>
          )}
          <div className="observed-balance">
            <small>Observed native balance</small>
            <strong style={{ overflowWrap: 'anywhere' }}>
              {snapshot.nativeBalance} <span>{snapshot.currency}</span>
            </strong>
          </div>
          <dl className="evm-tracker-facts">
            <dt>Canonical block</dt>
            <dd>{snapshot.block}</dd>
            {snapshot.blockHash && (
              <>
                <dt>Block hash</dt>
                <dd style={{ overflowWrap: 'anywhere' }}>
                  {snapshot.blockHash}
                </dd>
              </>
            )}
            <dt>Account nonce</dt>
            <dd>{snapshot.outgoingTransactions}</dd>
            <dt>Provider</dt>
            <dd>{snapshot.source}</dd>
            <dt>Observed</dt>
            <dd>{new Date(snapshot.observedAt).toLocaleString()}</dd>
          </dl>
          <p>{snapshot.coverage}</p>
        </>
      )}
      <p>
        Native units only. No ERC-20 inventory, incoming or internal transaction
        indexing, trade attribution, wallet age, USD value or signing. Nonce is
        not a verified trade count.
      </p>
    </section>
  );
}
