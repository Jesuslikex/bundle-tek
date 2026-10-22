'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import {
  savedAutoSellReview,
  validatedAutoSellReviewReference,
  type AutoSellReviewReference,
} from '@/lib/auto-sell-review-recovery';
import { autoSellSavedOutcomePage } from '@/lib/auto-sell-saved-outcomes';
import { readBoundedPanelJson } from '@/lib/read-bounded-panel-json';
import { AutoSellUnsignedCancel } from './auto-sell-unsigned-cancel';
import { Button } from './ui/button';
import { useRecoveryReadFocus } from './use-recovery-read-focus';
import styles from './auto-sell-saved-outcomes.module.css';
type Props = {
  reference: AutoSellReviewReference;
  projectId: string;
  mint: string;
  conflict?: boolean;
  allowCancellation?: boolean;
  onCancellationBlocked?: (blocked: boolean) => void;
};
export function AutoSellReviewRecovery(props: Props) {
  return (
    <ReviewRecovery
      key={JSON.stringify([props.reference, props.projectId, props.mint])}
      {...props}
    />
  );
}
function ReviewRecovery({
  reference,
  projectId,
  mint,
  conflict = false,
  allowCancellation = true,
  onCancellationBlocked,
}: Props) {
  const [result, setResult] = useState<ReturnType<
    typeof autoSellSavedOutcomePage
  > | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const active = useRef<AbortController | null>(null);
  const readButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const trackFocus = useRecoveryReadFocus(panel, readButton);
  const finishFocus = useRef<(() => void) | null>(null);
  const cancellationBlocked = useRef(false);
  const [blocked, setBlocked] = useState(false);
  useLayoutEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [],
  );
  async function read() {
    if (active.current || cancellationBlocked.current) return;
    const controller = new AbortController();
    active.current = controller;
    const doneFocus = trackFocus();
    finishFocus.current = doneFocus;
    setBusy(true);
    setMessage('');
    setResult(null);
    try {
      const ref = validatedAutoSellReviewReference(reference);
      if (ref.projectId !== projectId || ref.mint !== mint) throw Error();
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(15000),
      ]);
      const response = await fetch(
        `/api/imported-projects/signing?${new URLSearchParams({ projectId, preparationId: ref.preparationId })}`,
        {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
          redirect: 'error',
          signal,
        },
      );
      const value = await readBoundedPanelJson(response, signal);
      signal.throwIfAborted();
      if (!response.ok) throw Error();
      const saved = savedAutoSellReview(value, ref);
      const page = autoSellSavedOutcomePage(value, { projectId, mint });
      if (active.current !== controller) return;
      setResult(page);
      if (saved) onCancellationBlocked?.(false);
      setMessage(
        saved
          ? 'Original saved approval found. Status is historical; no receipt was checked.'
          : conflict
            ? 'No saved approval was returned for this preparation. A different approval, wallet reservation or changed context may be blocking the request. Do not assume this preparation is the blocking approval; inspect saved approvals or wallet history. Absence does not authorize a replacement or release a reservation.'
            : 'No saved approval was returned for this preparation. The original request may still be processing. Read again later; absence does not authorize a replacement or release a reservation.',
      );
    } catch {
      if (active.current === controller && !controller.signal.aborted)
        setMessage(
          'The original review could not be verified. Keep its preparation ID and use saved approval history. No approval was created, cancelled, signed or resent.',
        );
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
        doneFocus();
        finishFocus.current = null;
      }
    }
  }
  return (
    <section
      ref={panel}
      className={styles.panel}
      aria-label="Interrupted Auto Sell review"
    >
      <h3>Recover interrupted approval review</h3>
      <p>
        This run stopped before registration or submission. The server may have
        saved an approval and reserved the wallet. Nothing here restarts the
        strategy or changes its budget.
      </p>
      <p>
        Original preparation: <code>{reference.preparationId}</code>
      </p>
      <div className={styles.buttons}>
        <Button
          ref={readButton}
          variant="outline"
          disabled={busy || blocked}
          onClick={() => void read()}
        >
          Read original saved review
        </Button>
        {busy && (
          <Button
            variant="outline"
            onClick={() => {
              active.current?.abort();
              active.current = null;
              setBusy(false);
              setMessage('Read cancelled. No approval was changed.');
              finishFocus.current?.();
              finishFocus.current = null;
            }}
          >
            Cancel review read
          </Button>
        )}
      </div>
      <output aria-live="polite" aria-atomic="true">
        {busy ? 'Reading the original preparation…' : message}
      </output>
      {result?.rows.map((row) => (
        <div key={row.intentId}>
          <p>
            Approval <code>{row.intentId}</code> · initially loaded state:{' '}
            {row.state}
          </p>
          {row.state === 'awaiting_signature' && row.signature === null ? (
            <AutoSellUnsignedCancel
              projectId={projectId}
              mint={mint}
              row={row}
              disabled={!allowCancellation}
              onBlockedChange={(value) => {
                cancellationBlocked.current = value;
                setBlocked(value);
                onCancellationBlocked?.(value);
              }}
            />
          ) : (
            <p>
              This saved record is not unsigned. Use preparation history for
              receipt recovery. No signing or resend is available here.
            </p>
          )}
        </div>
      ))}
    </section>
  );
}
