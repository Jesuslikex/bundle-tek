'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { TrackedWallet } from '@/lib/tracked-wallet';
import type { TrackedTransactionSummary } from '@/lib/tracked-transaction-history';
import { signedBalanceAmount } from '@/lib/wallet-balance-format';
import bs58 from 'bs58';
import { TrackedSignatureBrowser } from './tracked-signature-browser';
export function TrackedTransactionHistory({
  wallet,
  onOpen,
  onClose,
  refreshVersion = 0,
}: {
  wallet: TrackedWallet;
  onOpen: (signature: string, saved: boolean) => void;
  onClose: () => void;
  refreshVersion?: number;
}) {
  const [items, setItems] = useState<TrackedTransactionSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [signature, setSignature] = useState('');
  const [signatureError, setSignatureError] = useState('');
  const request = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const query = useCallback(
    (cursor: string | null) =>
      '/api/tracker/transactions?' +
      new URLSearchParams({
        address: wallet.address,
        network: wallet.network,
        expectedUpdatedAt: wallet.updatedAt,
        ...(cursor ? { cursor } : {}),
      }),
    [wallet.address, wallet.network, wallet.updatedAt],
  );
  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    void fetch(query(null), { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json()) as {
          items?: TrackedTransactionSummary[];
          nextCursor?: string | null;
          error?: string;
        };
        if (!response.ok || !Array.isArray(data.items))
          throw new Error(data.error || 'Transaction history unavailable.');
        if (!controller.signal.aborted) {
          setItems(data.items);
          setCursor(data.nextCursor ?? null);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Transaction history unavailable.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => request.current?.abort();
  }, [query, refreshVersion]);
  async function load(older: boolean) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(query(older ? cursor : null), {
        cache: 'no-store',
        signal: controller.signal,
      });
      const data = (await response.json()) as {
        items?: TrackedTransactionSummary[];
        nextCursor?: string | null;
        error?: string;
      };
      if (!response.ok || !Array.isArray(data.items))
        throw new Error(data.error || 'Transaction history unavailable.');
      if (!controller.signal.aborted) {
        setItems((current) =>
          older
            ? [
                ...current,
                ...data.items!.filter(
                  (row) =>
                    !current.some((item) => item.signature === row.signature),
                ),
              ]
            : data.items!,
        );
        setCursor(data.nextCursor ?? null);
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Transaction history unavailable.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function inspect() {
    try {
      const value = signature.trim();
      if (value.length > 88 || bs58.decode(value).length !== 64)
        throw new Error('Invalid signature.');
      setSignatureError('');
      onOpen(value, false);
    } catch {
      setSignatureError('Enter a complete base58 transaction signature.');
    }
  }
  return (
    <section
      className="wallet-holdings-panel"
      aria-label="Saved tracked transactions"
    >
      <div className="wallet-roster-toolbar">
        <h2 ref={heading} tabIndex={-1}>
          Transaction history · {wallet.label || 'Tracked wallet'}
        </h2>
        <Button variant="outline" onClick={onClose}>
          Close transaction history
        </Button>
      </div>
      <p className="warmup-address">
        Solana {wallet.network} · {wallet.address}
      </p>
      <p className="source-note">
        History contains observations you inspected and saved here, including
        archived wallets. It is not a complete on-chain index or a finalized
        receipt ledger.
      </p>
      <TrackedSignatureBrowser wallet={wallet} onOpen={onOpen} />
      <div className="wallet-roster-toolbar">
        <Input
          aria-label="Transaction signature"
          placeholder="Paste a complete transaction signature"
          value={signature}
          onChange={(e) => {
            setSignature(e.target.value);
            setSignatureError('');
          }}
          maxLength={88}
        />
        <Button disabled={!signature.trim()} onClick={inspect}>
          Inspect and save transaction
        </Button>
      </div>
      {signatureError && <p role="alert">{signatureError}</p>}
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => void load(false)}
      >
        Reload saved transactions
      </Button>
      {error && <p role="alert">{error}</p>}
      {busy && <output>Loading saved transactions…</output>}
      <div className="wallet-roster-table">
        <table className="project-table">
          <thead>
            <tr>
              <th>Signature / saved</th>
              <th>Status / SOL change</th>
              <th>Token records</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.signature}>
                <td>
                  <code>
                    {item.signature.slice(0, 8)}…{item.signature.slice(-8)}
                  </code>
                  <small>
                    {new Date(item.observedAt).toLocaleString()} · slot{' '}
                    {item.slot}
                  </small>
                  {item.stale && (
                    <small>Saved before latest tracker change</small>
                  )}
                </td>
                <td>
                  {item.failed ? 'Failed transaction' : 'Confirmed transaction'}
                  <small>
                    {item.nativeChangeRaw === null
                      ? 'No native account entry'
                      : signedBalanceAmount(item.nativeChangeRaw, 9) + ' SOL'}
                  </small>
                </td>
                <td>
                  {item.tokensComplete ? item.tokenChangeCount : 'Unavailable'}
                </td>
                <td>
                  <Button
                    variant="outline"
                    onClick={() => onOpen(item.signature, true)}
                  >
                    Open saved observation
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!busy && !items.length && !error && (
        <p>
          No saved transaction observations yet. Inspect a signature to save its
          public wallet evidence.
        </p>
      )}
      {cursor && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void load(true)}
        >
          Load older saved transactions
        </Button>
      )}
    </section>
  );
}
