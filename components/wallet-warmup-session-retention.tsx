'use client';
import { useEffect, useRef, useState } from 'react';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import type { WalletWarmupSessionView } from '@/lib/wallet-warmup-session-view';
import {
  walletWarmupSessionRecovery,
  walletWarmupSessionSaveSelection,
  walletWarmupSessionRetainedView,
  type WarmupSessionRecovery,
  type RetainedWarmupSessionSummary,
} from '@/lib/wallet-warmup-session-retained-view';
import { UUID } from '@/lib/wallet-operation';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { Button } from './ui/button';
import { readPanelJson } from './read-panel-json';
import styles from './wallet-warmup-session-review.module.css';
import { WalletWarmupSessionConsent } from './wallet-warmup-session-consent';
export function WalletWarmupSessionRetention({
  plan,
  view,
  onBusyChange,
}: {
  plan: SavedWarmup;
  view: WalletWarmupSessionView | null;
  onBusyChange: (busy: boolean) => void;
}) {
  const pending = useRef<AbortController | null>(null),
    key = `bundle:warmup-review:${plan.id}`;
  const [marker, setMarker] = useState<WarmupSessionRecovery | null>(null),
    [reviewId, setReviewId] = useState(''),
    [invalidReminder, setInvalidReminder] = useState(false),
    [operation, setOperation] = useState<'save' | 'recover' | null>(null),
    [consentBusy, setConsentBusy] = useState(false),
    [retained, setRetained] = useState<RetainedWarmupSessionSummary | null>(
      null,
    ),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [clearedContext, setClearedContext] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    void Promise.resolve().then(() => {
      if (!mounted) return;
      try {
        const raw = sessionStorage.getItem(key);
        if (raw) {
          const saved = walletWarmupSessionRecovery(JSON.parse(raw), plan.id);
          setMarker(saved);
          setReviewId(saved.id);
          setMessage(
            'A recovery ID is available. Recover it to check whether the review was saved.',
          );
        }
      } catch {
        setInvalidReminder(true);
        setError(
          'The local recovery reminder is unavailable. Recover a known ID or clear the reminder before saving.',
        );
      }
    });
    return () => {
      mounted = false;
      pending.current?.abort();
      pending.current = null;
    };
  }, [key, plan.id]);
  useEffect(() => {
    onBusyChange(operation !== null || consentBusy);
    return () => onBusyChange(false);
  }, [operation, consentBusy, onBusyChange]);
  useEffect(() => {
    if (pending.current) {
      pending.current.abort();
      pending.current = null;
      setOperation(null);
      setMessage(
        'Review context changed. Recover any pending save by its review ID.',
      );
    }
  }, [view]);
  function stop() {
    pending.current?.abort();
    pending.current = null;
    setOperation(null);
    setMessage(
      operation === 'save'
        ? 'Stopped waiting. The save may have completed. Recover the same review ID; no retry was sent.'
        : 'Recovery stopped. No save request was sent.',
    );
  }
  function clearReminder() {
    if (pending.current) return;
    try {
      sessionStorage.removeItem(key);
    } catch {
      setError(
        'The local reminder could not be cleared. No server data changed.',
      );
      return;
    }
    setMarker(null);
    setInvalidReminder(false);
    setRetained(null);
    setClearedContext(view?.review.contextKey ?? null);
    setMessage(
      'Local reminder cleared. No server review was deleted. Request a fresh review before saving another.',
    );
    setError('');
  }
  function begin(kind: 'save' | 'recover') {
    const controller = new AbortController();
    pending.current = controller;
    setOperation(kind);
    setError('');
    setMessage('');
    return controller;
  }
  const live = (controller: AbortController) =>
    pending.current === controller && !controller.signal.aborted;
  async function save() {
    if (
      !view ||
      view.review.contextKey === clearedContext ||
      plan.archived ||
      pending.current ||
      marker ||
      invalidReminder
    )
      return;
    const controller = begin('save');
    let submitted = false;
    try {
      const selection = await walletWarmupSessionSaveSelection(view, plan);
      if (!live(controller)) return;
      if (Date.now() >= view.deadline)
        throw Error('The review expired. Request a fresh review.');
      try {
        sessionStorage.setItem(key, JSON.stringify(selection));
        if (sessionStorage.getItem(key) !== JSON.stringify(selection))
          throw Error('Reminder differs');
      } catch {
        throw Error(
          'Could not store a recovery ID. No save request was sent. Allow browser session storage before saving.',
        );
      }
      setMarker(selection);
      setReviewId(selection.id);
      setRetained(null);
      submitted = true;
      const response = await fetch(
        '/api/wallet-workspace/warmup/session-reviews',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...selection, save: true }),
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]),
        },
      );
      const data = await readPanelJson(
        response,
        'Review save response unavailable.',
      );
      if (!live(controller)) return;
      if (!response.ok)
        throw Error(
          'The save was not confirmed. Recover the same review ID before saving again.',
        );
      const result = await walletWarmupSessionRetainedView(
        data,
        selection,
        view.review,
      );
      if (live(controller)) {
        setRetained(result);
        setMessage(
          'Review saved for recovery. No trading approval was given and no session was started.',
        );
      }
    } catch (cause) {
      if (live(controller))
        setError(
          submitted
            ? 'Save outcome is unconfirmed. Recover the same review ID before saving again. No automatic retry was sent.'
            : cause instanceof Error
              ? cause.message
              : 'Review save unavailable. No request was sent.',
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setOperation(null);
      }
    }
  }
  async function recover() {
    if (
      pending.current ||
      !UUID.test(reviewId) ||
      reviewId !== reviewId.toLowerCase()
    )
      return;
    const controller = begin('recover'),
      expected =
        marker?.id === reviewId ? marker : { id: reviewId, planId: plan.id };
    try {
      const response = await fetch(
        '/api/wallet-workspace/warmup/session-reviews?id=' +
          encodeURIComponent(reviewId),
        {
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]),
        },
      );
      const data = await readPanelJson(
        response,
        'Retained review unavailable.',
      );
      if (!live(controller)) return;
      if (!response.ok)
        throw Error(
          response.status === 404
            ? 'This review was not found for this account. A missing record does not cancel a save that may still be pending. Keep the ID and recover again.'
            : 'Recovery unavailable. Keep the review ID and try recovering again.',
        );
      const result = await walletWarmupSessionRetainedView(data, expected);
      if (live(controller)) {
        setRetained(result);
        setMessage(
          'Saved review recovered. This is historical evidence, not permission to trade.',
        );
      }
    } catch (cause) {
      if (live(controller))
        setError(
          cause instanceof Error
            ? cause.message
            : 'Recovery unavailable. Keep the review ID.',
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setOperation(null);
      }
    }
  }
  const busy = operation !== null || consentBusy;
  return (
    <section
      className={styles.retention}
      aria-label="Save and recover session review"
      aria-busy={busy}
    >
      <h6>Save for recovery</h6>
      <p>Retain this exact review. Saving does not approve or start trades.</p>
      <div className={styles.controls}>
        <Button
          variant="outline"
          disabled={
            !view ||
            view.review.contextKey === clearedContext ||
            plan.archived ||
            busy ||
            !!marker ||
            invalidReminder
          }
          onClick={() => void save()}
        >
          Save reviewed session
        </Button>
        {busy && (
          <Button variant="outline" onClick={stop}>
            Stop waiting
          </Button>
        )}
      </div>
      {!view && !marker && (
        <p>Request a fresh automatic session review above before saving.</p>
      )}
      {marker && (
        <p>
          Recovery ID: <code>{marker.id}</code>. Keep this ID if you clear
          browser storage.{' '}
          {retained
            ? 'To save a different review, clear the local reminder below and request a fresh review.'
            : 'Recover this save before creating another.'}
        </p>
      )}
      <label className={styles.recoveryInput}>
        Saved session review ID
        <input
          aria-label="Saved session review ID"
          value={reviewId}
          maxLength={36}
          disabled={busy}
          onChange={(event) => {
            setReviewId(event.target.value.trim());
            setRetained(null);
            setError('');
          }}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className={styles.controls}>
        <Button
          variant="outline"
          disabled={
            busy || !UUID.test(reviewId) || reviewId !== reviewId.toLowerCase()
          }
          onClick={() => void recover()}
        >
          Recover saved review
        </Button>
      </div>
      {operation && (
        <output>
          {operation === 'save'
            ? 'Saving the exact review once. No signing or trades.'
            : 'Reading the saved review. No save or signing.'}
        </output>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <output>{message}</output>}
      {retained && (
        <div className={styles.retained}>
          <strong>Saved review only</strong>
          <p>
            {retained.actionCount}{' '}
            {retained.actionCount === 1 ? 'action' : 'actions'} across{' '}
            {retained.walletCount}{' '}
            {retained.walletCount === 1 ? 'wallet' : 'wallets'}. Maximum further
            spend in this historical review:{' '}
            {formatNativeBalance(retained.maximumNativeSpendLamports, 9)} SOL.
          </p>
          <p>
            Plan revision {retained.planRevision}
            {retained.planRevision !== plan.revision
              ? ' (earlier than the currently opened revision)'
              : ''}
            . Saved {new Date(retained.createdAt).toLocaleString()}.
          </p>
          <code>{retained.id}</code>
          <p>
            A new review and separate execution approval will be required before
            any future automatic session can run.
          </p>
        </div>
      )}
      {(marker || invalidReminder) && (
        <details>
          <summary>Local recovery reminder</summary>
          <p>
            Clearing the reminder cannot cancel a save or delete server history.
            Keep the review ID first; you can paste it above to recover later.
          </p>
          <Button variant="ghost" disabled={busy} onClick={clearReminder}>
            Clear local reminder
          </Button>
        </details>
      )}
      {retained && (
        <WalletWarmupSessionConsent
          key={retained.id}
          plan={plan}
          view={view}
          retained={retained}
          onBusyChange={setConsentBusy}
        />
      )}
    </section>
  );
}
