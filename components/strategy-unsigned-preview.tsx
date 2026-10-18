'use client';
import { useEffect, useRef, useState } from 'react';
import type { SavedStrategyDraft } from '@/lib/strategy-session-drafts';
import type { StrategyCapacityView } from '@/lib/strategy-capacity-client';
import type { StrategyUnsignedPreview } from '@/lib/strategy-unsigned-preview';
import {
  readStrategyUnsignedPreview,
  requestStrategyUnsignedPreview,
} from '@/lib/strategy-unsigned-preview-client';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { Button } from './ui/button';
export function StrategyUnsignedPreviewPanel({
  draft,
  capacity,
  holdId,
  conditionPool,
}: {
  draft: SavedStrategyDraft;
  capacity: StrategyCapacityView;
  holdId: string;
  conditionPool: string | null;
}) {
  const [result, setResult] = useState<{
      value: StrategyUnsignedPreview;
      until: number;
    } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [expired, setExpired] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      const controller = pending.current;
      pending.current = null;
      controller?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, result.until - performance.now()),
    );
    return () => clearTimeout(timer);
  }, [result]);
  async function preview() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const start = performance.now();
    setBusy(true);
    setError('');
    setResult(null);
    setExpired(false);
    try {
      const raw = await requestStrategyUnsignedPreview(
        {
          projectId: draft.plan.input.projectId,
          draftId: draft.id,
          revision: capacity.revision,
          holdId,
          conditionPool,
        },
        controller.signal,
      );
      const value = await readStrategyUnsignedPreview(
        raw,
        draft,
        capacity,
        holdId,
        conditionPool,
      );
      if (controller.signal.aborted || pending.current !== controller) return;
      const until =
        start + Date.parse(value.expiresAt) - Date.parse(value.startedAt);
      if (until <= performance.now())
        throw Error('Preview expired. Request a fresh preview when ready.');
      setResult({ value, until });
    } catch (e) {
      if (pending.current === controller)
        setError(
          e instanceof Error ? e.message : 'Unsigned preview unavailable.',
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  const value = !expired ? result?.value : null;
  return (
    <section aria-label="Unsigned strategy preview">
      <p>
        Preview this candidate with current balances, a quote and simulation.
        Signing stays unavailable.
      </p>
      {conditionPool && (
        <p>
          The selected pool supplies the Limit condition. Jupiter may route the
          swap through other pools.
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => void preview()}
      >
        Preview unsigned trade
      </Button>
      {busy && (
        <>
          <output>Checking balances, quote and simulation.</output>
          <Button
            type="button"
            variant="outline"
            onClick={() => pending.current?.abort()}
          >
            Cancel preview
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {expired && (
        <output>
          This preview expired. Request a fresh preview to see current
          estimates.
        </output>
      )}
      {value && (
        <div>
          <output>
            Unsigned quote and simulation checked. No trade is approved.
          </output>
          <p>
            Input:{' '}
            {formatNativeBalance(
              value.quote.inputRaw,
              draft.plan.summary.inputDecimals,
            )}{' '}
            {draft.plan.input.side === 'Buy' ? 'SOL' : draft.plan.token.symbol}.
          </p>
          <p>
            Minimum output:{' '}
            {formatNativeBalance(
              value.quote.minimumOutputRaw,
              draft.plan.input.side === 'Buy' ? draft.plan.token.decimals : 9,
            )}{' '}
            {draft.plan.input.side === 'Buy' ? draft.plan.token.symbol : 'SOL'}.
          </p>
          <p>
            Network fee:{' '}
            {formatNativeBalance(value.simulation.networkFeeLamports, 9)} SOL.
            Maximum temporary SOL debit:{' '}
            {formatNativeBalance(
              value.simulation.maximumNativeDebitLamports,
              9,
            )}{' '}
            SOL, including account rent.
          </p>
          <p>
            Quoted platform fee: {value.quote.platformFeeBps / 100}%
            {value.quote.platformFeeMint
              ? ` in ${value.quote.platformFeeMint}`
              : ''}
            .
          </p>
          <p>
            Balances are observations and are not reserved. Wallet access and
            production program qualification remain unchecked.
          </p>
          <details>
            <summary>Preview details</summary>
            <p>
              Wallet: {value.checks.wallet}. Router: Jupiter Metis. Slippage:
              0.5%.
            </p>
            <p>
              Observed: {value.previewedAt}. Expires: {value.expiresAt}.
              Simulation slot: {value.simulation.slot}.
            </p>
            <p>
              Unsigned packet fingerprint: {value.quote.sha256}. Preview
              fingerprint: {value.sha256}.
            </p>
          </details>
        </div>
      )}
    </section>
  );
}
