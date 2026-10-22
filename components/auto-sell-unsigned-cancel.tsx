'use client';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { autoSellSavedOutcomePage } from '@/lib/auto-sell-saved-outcomes';
import { readBoundedPanelJson } from '@/lib/read-bounded-panel-json';
import { Button } from './ui/button';
import { useRecoveryReadFocus } from './use-recovery-read-focus';
import styles from './auto-sell-saved-outcomes.module.css';
type Row = ReturnType<typeof autoSellSavedOutcomePage>['rows'][number];
type Props = {
  projectId: string;
  mint: string;
  row: Row;
  disabled?: boolean;
  onBlockedChange?: (blocked: boolean) => void;
};
export function AutoSellUnsignedCancel(props: Props) {
  return (
    <UnsignedCancel
      key={JSON.stringify([props.projectId, props.mint, props.row])}
      {...props}
    />
  );
}
function UnsignedCancel({
  projectId,
  mint,
  row,
  disabled = false,
  onBlockedChange,
}: Props) {
  const [approved, setApproved] = useState(false);
  const [phase, setPhase] = useState<
    'idle' | 'cancelling' | 'needs-read' | 'reading' | 'resolved' | 'blocked'
  >('idle');
  const [message, setMessage] = useState('');
  const [state, setState] = useState(row.state);
  const active = useRef<AbortController | null>(null);
  const readButton = useRef<HTMLButtonElement>(null);
  const consent = useId();
  const panel = useRef<HTMLElement>(null);
  const trackFocus = useRecoveryReadFocus(panel, readButton);
  useLayoutEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [],
  );
  const [previousDisabled, setPreviousDisabled] = useState(disabled);
  if (previousDisabled !== disabled) {
    setPreviousDisabled(disabled);
    setApproved(false);
  }
  const unsigned = state === 'awaiting_signature' && row.signature === null;
  async function act(cancel: boolean) {
    if (
      active.current ||
      (cancel && (disabled || !approved || !unsigned || phase !== 'idle'))
    )
      return;
    const controller = new AbortController();
    active.current = controller;
    const finishFocus = trackFocus();
    onBlockedChange?.(true);
    setApproved(false);
    setMessage('');
    setPhase(cancel ? 'cancelling' : 'reading');
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15000),
    ]);
    try {
      const response = await fetch(
        cancel
          ? '/api/imported-projects/signing'
          : `/api/imported-projects/signing?${new URLSearchParams({ projectId, intentId: row.intentId })}`,
        {
          method: cancel ? 'POST' : 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
          redirect: 'error',
          signal,
          ...(cancel
            ? {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'cancel', id: row.intentId }),
              }
            : {}),
        },
      );
      const value = await readBoundedPanelJson(response, signal);
      signal.throwIfAborted();
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) {
          if (active.current === controller) setPhase('blocked');
          throw Error('access');
        }
        if (cancel && response.status === 409) throw Error('refused');
        throw Error();
      }
      if (active.current !== controller) return;
      if (cancel) {
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          (value as { state?: unknown }).state !== 'cancelled'
        )
          throw Error();
        setPhase('needs-read');
        setMessage(
          'Cancellation acknowledged. Check saved status before starting a new strategy. No transaction was sent or reversed.',
        );
      } else {
        const page = autoSellSavedOutcomePage(value, {
          projectId,
          mint,
          intentId: row.intentId,
        });
        const saved = page.rows[0];
        if (
          page.rows.length !== 1 ||
          saved.preparationId !== row.preparationId ||
          saved.projectRevision !== row.projectRevision ||
          saved.walletRevision !== row.walletRevision ||
          saved.wallet !== row.wallet ||
          saved.inputRaw !== row.inputRaw
        )
          throw Error();
        setState(saved.state);
        onBlockedChange?.(false);
        setPhase(
          saved.state === 'awaiting_signature' && saved.signature === null
            ? 'idle'
            : 'resolved',
        );
        setMessage(
          saved.state === 'cancelled'
            ? 'Saved approval is cancelled. This does not restore or resume the Auto Sell session.'
            : saved.state === 'awaiting_signature'
              ? 'Saved approval is still awaiting signature. A fresh cancellation approval is required.'
              : 'Saved approval is no longer unsigned. Use receipt recovery; cancellation and resend are unavailable here.',
        );
      }
    } catch (error) {
      if (active.current === controller && !controller.signal.aborted) {
        setPhase((current) =>
          current === 'blocked' ? 'blocked' : 'needs-read',
        );
        setMessage(
          error instanceof Error && error.message === 'access'
            ? 'Saved approval access is unavailable. Check sign-in and project access before another read.'
            : error instanceof Error && error.message === 'refused'
              ? 'Cancellation was refused. Signed, changed or bundle-bound approvals cannot be cancelled here. Check saved status; no automatic retry was made.'
              : cancel
                ? 'Cancellation outcome is unknown. Check this original saved approval; no automatic retry was made.'
                : 'Saved status could not be verified. Cancellation stays unavailable until a matching read succeeds.',
        );
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        finishFocus();
      }
    }
  }
  return (
    <section
      ref={panel}
      className={styles.panel}
      aria-label="Unsigned approval recovery"
    >
      <p>
        Cancel only this saved unsigned approval. Signed or submitted
        transactions require receipt recovery. Cancellation does not reconcile
        trading limits, prove unused funds or resume a strategy.
      </p>
      {disabled && (
        <p>
          Stop Auto Sell and wait for pending work to settle before cancelling
          an unsigned approval.
        </p>
      )}
      {unsigned && phase === 'idle' && (
        <label className={styles.consent} htmlFor={consent}>
          <input
            id={consent}
            type="checkbox"
            checked={approved}
            disabled={disabled}
            onChange={(event) => setApproved(event.target.checked)}
          />
          I approve cancelling this unsigned approval only.
        </label>
      )}
      <div className={styles.buttons}>
        {unsigned && phase === 'idle' && (
          <Button
            variant="outline"
            disabled={disabled || !approved}
            onClick={() => void act(true)}
          >
            Cancel unsigned approval
          </Button>
        )}
        <Button
          ref={readButton}
          variant="outline"
          disabled={phase === 'reading' || phase === 'cancelling'}
          onClick={() => void act(false)}
        >
          Check saved status
        </Button>
      </div>
      <output aria-live="polite" aria-atomic="true">
        {phase === 'cancelling'
          ? 'Requesting cancellation…'
          : phase === 'reading'
            ? 'Reading original saved status…'
            : message}
      </output>
    </section>
  );
}
