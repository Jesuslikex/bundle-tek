'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import type { SolanaSwapPreparation } from '@/lib/warmup-swap-quote';
import type { WarmupSettlement } from '@/lib/warmup-native-settlement';
import { warmupReviewDeadline } from '@/lib/warmup-review-wait';
type Checks = {
  preparationId: string;
  projectId: string;
  projectRevision: number;
  walletRevision: number;
  wallet: string;
  sha256: string;
  side: string;
  expiresAt: string;
  observedAt: string;
  source: string;
  networkFeeLamports: string;
  settlement: WarmupSettlement;
  executionAllowed: false;
  approvalCreated: false;
};
export function ImportedSigningChecks({
  preparationId,
  projectId,
  projectRevision,
  walletRevision,
  order,
  reviewNotBefore,
}: {
  preparationId: string;
  projectId: string;
  projectRevision: number;
  walletRevision: number;
  order: SolanaSwapPreparation;
  reviewNotBefore: number;
}) {
  const pending = useRef<AbortController | null>(null);
  const [checks, setChecks] = useState<Checks | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [deadline, setDeadline] = useState(reviewNotBefore),
    [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (Date.parse(order.expiresAt) <= current) clearInterval(timer);
    }, 250);
    return () => {
      clearInterval(timer);
      pending.current?.abort();
    };
  }, [order.expiresAt]);
  const expired = Date.parse(order.expiresAt) <= now;
  const wait = Math.max(0, Math.ceil((deadline - now) / 1000));
  async function inspect() {
    if (busy || expired || Date.now() < deadline) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setChecks(null);
    setError('');
    try {
      const response = await fetch('/api/imported-projects/signing-checks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(30000),
        ]),
        body: JSON.stringify({
          preparationId,
          transaction: order.preparation.transaction,
        }),
      });
      const data = (await response.json()) as {
        checks?: Checks;
        error?: string;
        reviewWaitMs?: number;
      };
      if (controller.signal.aborted) return;
      if (response.status === 429 && data.reviewWaitMs !== undefined)
        setDeadline(warmupReviewDeadline(data.reviewWaitMs));
      const value = data.checks;
      if (
        !response.ok ||
        !value ||
        value.preparationId !== preparationId ||
        value.projectId !== projectId ||
        value.projectRevision !== projectRevision ||
        value.walletRevision !== walletRevision ||
        value.wallet !== order.preparation.wallet ||
        value.sha256 !== order.preparation.sha256 ||
        value.side !== order.side ||
        value.expiresAt !== order.expiresAt ||
        value.executionAllowed !== false ||
        value.approvalCreated !== false ||
        Date.parse(value.expiresAt) <= Date.now() ||
        !value.settlement ||
        value.settlement.version !== 1 ||
        !Array.isArray(value.settlement.lookupTables) ||
        [
          value.networkFeeLamports,
          value.settlement.maximumRentLamports,
          value.settlement.maximumNativeDebitLamports,
          value.settlement.wrappedFromNativeRaw,
        ].some(
          (raw) => typeof raw !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(raw),
        )
      )
        throw new Error(
          data.error || 'Signing checks do not match this saved transaction.',
        );
      setChecks(value);
    } catch (err) {
      if (!controller.signal.aborted)
        setError(
          err instanceof Error ? err.message : 'Signing checks unavailable.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="Imported transaction signing requirements">
      <h5>Signing requirements</h5>
      <p>
        Recheck the exact saved packet, supported route, token changes, SOL
        wrapping, account rent and lookup tables. Signing and submission for
        imported projects are not available yet. These checks do not authorize a
        trade.
      </p>
      <Button
        variant="outline"
        disabled={busy || expired || wait > 0}
        onClick={() => void inspect()}
      >
        {busy
          ? 'Checking signing requirements…'
          : expired
            ? 'Expired. Prepare a fresh order.'
            : wait > 0
              ? `Check signing requirements in ${wait}s`
              : 'Check signing requirements'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {checks && !expired && (
        <>
          <p>
            Supported packet checks passed. No approval or signature created.
          </p>
          <p>
            RPC network fee: {checks.networkFeeLamports} lamports. Maximum
            account rent: {checks.settlement.maximumRentLamports} lamports.
            Maximum upfront SOL debit:{' '}
            {checks.settlement.maximumNativeDebitLamports} lamports.
          </p>
          <p>
            Native SOL to wrap: {checks.settlement.wrappedFromNativeRaw}{' '}
            lamports. {checks.settlement.lookupTables.length} lookup tables
            rechecked.
          </p>
          <p>
            {checks.source} · {new Date(checks.observedAt).toLocaleString()}
          </p>
        </>
      )}
    </section>
  );
}
