'use client';
import { SwapFailureEvidence } from './swap-failure-evidence';
import { validatedWarmupFailure } from '@/lib/warmup-approval-history';
import type { WarmupSigningReview } from '@/lib/warmup-signing';
import type { SwapFailureReceipt } from '@/lib/swap-failure';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
export function WarmupSigningRecovery({
  preparationId,
}: {
  preparationId: string;
}) {
  const [intent, setIntent] = useState<{
      id: string;
      state: string;
      signature: string | null;
      document: WarmupSigningReview;
      failureReceipt?: SwapFailureReceipt | null;
    } | null>(null),
    [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function read(action?: 'recover' | 'cancel') {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(
        action
          ? '/api/wallet-workspace/warmup/signing'
          : `/api/wallet-workspace/warmup/signing?preparationId=${encodeURIComponent(preparationId)}`,
        {
          method: action ? 'POST' : 'GET',
          headers: action ? { 'content-type': 'application/json' } : {},
          body: action ? JSON.stringify({ action, id: intent?.id }) : undefined,
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(30000),
          ]),
        },
      );
      const data = (await response.json()) as {
        error?: string;
        message?: string;
        state?: string;
        signature?: string;
        failureReceipt?: SwapFailureReceipt;
        intent?: {
          id: string;
          state: string;
          signature: string | null;
          document: WarmupSigningReview;
          failureReceipt?: SwapFailureReceipt | null;
        };
      };
      if (!response.ok) throw new Error(data.error || 'Recovery unavailable.');
      const next = action
        ? intent
          ? {
              ...intent,
              state: data.state ?? intent.state,
              failureReceipt: data.failureReceipt ?? intent.failureReceipt,
            }
          : null
        : (data.intent ?? null);
      if (
        next &&
        (next.document?.id !== next.id ||
          next.document.preparationId !== preparationId ||
          next.document.network !== 'mainnet')
      )
        throw new Error('Approval context differs.');
      if (
        action &&
        (action === 'cancel'
          ? data.state !== 'cancelled'
          : data.signature !== intent?.signature)
      )
        throw new Error('Recovery signature differs.');
      if (next) validatedWarmupFailure(next);
      if (controller.signal.aborted) return;
      setIntent(next);
      if (!action) setChecked(true);
      setMessage(data.message ?? '');
    } catch (err) {
      if (!controller.signal.aborted)
        setMessage(err instanceof Error ? err.message : 'Recovery failed.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="Warmup approval recovery">
      <Button variant="outline" disabled={busy} onClick={() => void read()}>
        Read approval status
      </Button>
      {checked && !intent && (
        <p>No signing approval saved for this preparation.</p>
      )}
      {intent && (
        <>
          <p>
            Approval {intent.id}. State: {intent.state}.{' '}
            {intent.signature && `Registered signature: ${intent.signature}`}
          </p>
          {intent.state === 'awaiting_signature' && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void read('cancel')}
            >
              Cancel unsigned approval
            </Button>
          )}
          {intent.signature &&
            (['signed', 'submitted'].includes(intent.state) ||
              (intent.state === 'failed' && !intent.failureReceipt)) && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void read('recover')}
              >
                {intent.state === 'failed'
                  ? 'Check original failure evidence'
                  : 'Check finalized outcome'}
              </Button>
            )}
          {intent.state === 'failed' && (
            <SwapFailureEvidence receipt={intent.failureReceipt} />
          )}
          <p>
            Verify a successful transaction in the matching buy or sell receipt
            form to finish accounting. Unknown outcomes remain reserved.
          </p>
        </>
      )}
      {busy && <output>Reading approval…</output>}
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
