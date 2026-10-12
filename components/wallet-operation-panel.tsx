'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import type {
  WalletOperation,
  WalletOperationDocument,
} from '@/lib/wallet-operation';
export function WalletOperationPanel({
  active,
  error,
  loading,
  verified,
  refresh,
  onResolved,
  available = true,
}: {
  active: WalletOperation | null;
  error: string;
  loading: boolean;
  verified: boolean;
  refresh: () => void;
  onResolved: (signature: string, outcome: 'finalized' | 'failed') => void;
  available?: boolean;
}) {
  const [signature, setSignature] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function recover() {
    if (!active || !verified || busy) return;
    setBusy(true);
    setNotice('');
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    try {
      const intent = JSON.parse(active.document) as WalletOperationDocument;
      const response = await fetch('/api/wallet/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: current.signal,
        body: JSON.stringify({
          address: active.walletAddress,
          signature: active.signature || signature.trim(),
          operationId: active.id,
          ...(intent.kind === 'spl'
            ? intent.funding
              ? { savedFunding: true }
              : {
                  distribution: intent.distribution,
                  recipient: intent.recipient,
                }
            : intent.kind === 'sol'
              ? { nativeFunding: true }
              : {}),
        }),
      });
      const result = (await response.json()) as {
        recorded?: boolean;
        outcome?: 'finalized' | 'failed';
        event?: { transactionSignature: string };
        error?: string;
      };
      if (
        !response.ok ||
        !result.recorded ||
        !result.event ||
        !['finalized', 'failed'].includes(result.outcome || '')
      )
        throw new Error(result.error || 'Receipt remains unresolved.');
      if (!current.signal.aborted) {
        onResolved(result.event.transactionSignature, result.outcome!);
        refresh();
        setNotice(
          result.outcome === 'failed'
            ? 'Finalized failure verified. The reservation is resolved; no transfer completed. Network fees may have been charged. Prepare a fresh review before retrying.'
            : 'Existing transaction verified. The wallet reservation is resolved.',
        );
      }
    } catch (e) {
      if (!current.signal.aborted) {
        setNotice(
          e instanceof Error ? e.message : 'Receipt remains unresolved.',
        );
        refresh();
      }
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  }
  return (
    <div
      className="wallet-audit wallet-operation-panel"
      aria-label="Pending wallet operation"
    >
      <strong>Pending wallet operation</strong>
      <p>
        {!available
          ? 'Connect a devnet wallet to load pending operations.'
          : loading
            ? 'Loading account reservation…'
            : error ||
              (!active
                ? 'No unresolved operation for this wallet.'
                : `${active.kind === 'sol' ? 'Native SOL funding' : active.kind === 'spl' ? 'Token transfer' : 'Devnet memo'} · ${active.state === 'submitted' ? 'signature recorded; broadcast outcome unverified' : active.state.replaceAll('_', ' ')} · ${active.id}`)}
      </p>
      <Button
        variant="outline"
        disabled={!available || loading || busy}
        onClick={refresh}
      >
        Refresh pending operation
      </Button>
      {active && (
        <>
          <p>
            {active.state === 'preparing'
              ? `Approval has not begun. Reservation expires ${new Date(active.expiresAt).toLocaleString()}.`
              : 'Another submission is blocked. Verify the existing transaction; an uncertain approval does not expire automatically.'}
          </p>
          {active.signature ? (
            <code>{active.signature}</code>
          ) : active.state !== 'preparing' ? (
            <Input
              aria-label="Existing transaction signature"
              placeholder="Paste the existing transaction signature"
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
            />
          ) : null}
          <Button
            disabled={
              !verified ||
              busy ||
              active.state === 'preparing' ||
              (!active.signature && !signature.trim())
            }
            onClick={() => void recover()}
          >
            Verify existing receipt
          </Button>
        </>
      )}
      {notice && <output>{notice}</output>}
    </div>
  );
}
