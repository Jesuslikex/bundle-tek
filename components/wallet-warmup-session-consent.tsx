'use client';
import { useEffect, useRef, useState } from 'react';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import type { WalletWarmupSessionView } from '@/lib/wallet-warmup-session-view';
import type { RetainedWarmupSessionSummary } from '@/lib/wallet-warmup-session-retained-view';
import {
  warmupConsentPreview,
  warmupConsentSaved,
  warmupConsentRecovery,
  warmupConsentSaveSelection,
  warmupConsentConflict,
  WarmupConsentConflictError,
  readWarmupConsentResponse,
  WARMUP_CONSENT_FINISH_MINUTES,
  type WarmupConsentPreview,
  type WarmupConsentRecovery,
} from '@/lib/wallet-warmup-session-consent-view';
import { UUID } from '@/lib/wallet-operation';
import { WARMUP_RECEIPT_SAVED } from '@/lib/warmup-receipt-events';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { Button } from './ui/button';
import { WalletWarmupSessionProgress } from './wallet-warmup-session-progress';
import { WalletWarmupSessionV2 } from './wallet-warmup-session-v2';
import v2Styles from './wallet-warmup-session-v2.module.css';
import styles from './wallet-warmup-session-consent.module.css';
const endpoint = '/api/wallet-workspace/warmup/session-consents';
const quantity = (count: number, label: string) =>
  `${count} ${label}${count === 1 ? '' : 's'}`;
type Props = {
  plan: SavedWarmup;
  view: WalletWarmupSessionView | null;
  retained: RetainedWarmupSessionSummary;
  onBusyChange: (busy: boolean) => void;
};
export function WalletWarmupSessionConsent(props: Props) {
  const { onBusyChange } = props;
  const [legacyBusy, setLegacyBusy] = useState(false),
    [v2Busy, setV2Busy] = useState(false);
  useEffect(() => {
    onBusyChange(legacyBusy || v2Busy);
    return () => onBusyChange(false);
  }, [legacyBusy, v2Busy, onBusyChange]);
  return (
    <div>
      {v2Busy && (
        <output>
          Finish the new session request to use existing approval recovery.
        </output>
      )}
      {legacyBusy && (
        <output>
          Finish the existing approval request to use the new session controls.
        </output>
      )}
      <fieldset className={v2Styles.compatibility} disabled={v2Busy}>
        <details>
          <summary>Existing approval recovery · short review window</summary>
          <ConsentPanel
            key={JSON.stringify([
              props.plan,
              props.retained.id,
              props.view?.review.contextKey ?? null,
            ])}
            {...props}
            onBusyChange={setLegacyBusy}
          />
        </details>
      </fieldset>
      <fieldset className={v2Styles.compatibility} disabled={legacyBusy}>
        <WalletWarmupSessionV2 {...props} onBusyChange={setV2Busy} />
      </fieldset>
    </div>
  );
}
function ConsentPanel({ plan, view, retained, onBusyChange }: Props) {
  const pending = useRef<AbortController | null>(null),
    storageKey = `bundle:warmup-consent:${plan.id}`;
  const [operation, setOperation] = useState<
      'review' | 'save' | 'recover' | null
    >(null),
    [finish, setFinish] = useState(1),
    [prepared, setPrepared] = useState<WarmupConsentPreview | null>(null),
    [approved, setApproved] = useState(false),
    [marker, setMarker] = useState<WarmupConsentRecovery | null>(null),
    [invalidReminder, setInvalidReminder] = useState(false),
    [sourceExpired, setSourceExpired] = useState(false),
    [recoveryId, setRecoveryId] = useState(''),
    [originalId, setOriginalId] = useState<string | null>(null),
    [saved, setSaved] = useState<Awaited<
      ReturnType<typeof warmupConsentSaved>
    > | null>(null),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [clearedContext, setClearedContext] = useState<string | null>(null);
  const [journalBusy, setJournalBusy] = useState(false);
  useEffect(() => {
    let mounted = true;
    void Promise.resolve().then(() => {
      if (!mounted) return;
      try {
        const value = sessionStorage.getItem(storageKey);
        if (value) {
          const found = warmupConsentRecovery(JSON.parse(value), plan.id);
          setMarker(found);
          setRecoveryId(found.id);
          setMessage(
            'An approval recovery ID is available. Recover it before saving another.',
          );
        }
      } catch {
        setInvalidReminder(true);
        setError(
          'The local approval reminder is unreadable. Recover a known ID or clear the reminder before saving.',
        );
      }
    });
    return () => {
      mounted = false;
      pending.current?.abort();
      pending.current = null;
    };
  }, [plan.id, storageKey]);
  useEffect(() => {
    onBusyChange(operation !== null || journalBusy);
    return () => onBusyChange(false);
  }, [operation, journalBusy, onBusyChange]);
  useEffect(() => {
    const invalidate = () => {
      pending.current?.abort();
      pending.current = null;
      setOperation(null);
      setPrepared(null);
      setApproved(false);
      setSourceExpired(true);
      setMessage(
        'Context changed. Recover any pending approval by its original ID before another save.',
      );
    };
    const receipt = (event: Event) => {
      if ((event as CustomEvent).detail?.planId === plan.id) invalidate();
    };
    window.addEventListener('pagehide', invalidate);
    window.addEventListener('storage', invalidate);
    window.addEventListener(WARMUP_RECEIPT_SAVED, receipt);
    return () => {
      window.removeEventListener('pagehide', invalidate);
      window.removeEventListener('storage', invalidate);
      window.removeEventListener(WARMUP_RECEIPT_SAVED, receipt);
    };
  }, [plan.id]);
  useEffect(() => {
    if (!view) return;
    const timer = setTimeout(
      () => {
        pending.current?.abort();
        pending.current = null;
        setOperation(null);
        setPrepared(null);
        setApproved(false);
        setSourceExpired(true);
        setMessage(
          'The source review expired. Recover any pending save by its approval ID; request a fresh session review before a new approval.',
        );
      },
      Math.max(0, view.deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [view]);
  const fresh =
    !!view &&
    !sourceExpired &&
    !plan.archived &&
    view.review.contextKey !== clearedContext &&
    retained.planRevision === plan.revision &&
    retained.reviewedAt === view.review.reviewedAt;
  const last = view?.review.actions.length
    ? Math.max(...view.review.actions.map((a) => Date.parse(a.scheduledAt)))
    : null;
  const selectedDeadline =
    last === null ? '' : new Date(last + finish * 60000).toISOString();
  const busy = operation !== null || journalBusy;
  function begin(kind: NonNullable<typeof operation>) {
    if (pending.current) return null;
    const c = new AbortController();
    pending.current = c;
    setOperation(kind);
    setError('');
    setMessage('');
    return c;
  }
  const live = (c: AbortController) =>
    pending.current === c && !c.signal.aborted;
  const finishOperation = (c: AbortController) => {
    if (pending.current === c) {
      c.abort();
      pending.current = null;
      setOperation(null);
    }
  };
  function stop() {
    pending.current?.abort();
    pending.current = null;
    setOperation(null);
    setApproved(false);
    setMessage(
      operation === 'save'
        ? 'Stopped waiting. The approval may have been saved; recover the same ID. No retry was sent.'
        : 'Stopped waiting. No approval save was sent.',
    );
  }
  async function send(body: unknown, c: AbortController) {
    const signal = AbortSignal.any([c.signal, AbortSignal.timeout(10000)]);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal,
    });
    const data = await readWarmupConsentResponse(response, signal);
    if (response.status === 409) {
      const conflict = warmupConsentConflict(data);
      if (conflict) throw conflict;
    }
    if (!response.ok)
      throw Error(
        response.status === 409
          ? 'The review changed or expired. Recover any saved approval, then request a fresh session review.'
          : 'Plan approval is unavailable here. Keep any recovery ID and try recovering it.',
      );
    return data;
  }
  async function review() {
    if (!fresh || !view || !selectedDeadline || marker || invalidReminder)
      return;
    const c = begin('review');
    if (!c) return;
    setPrepared(null);
    setApproved(false);
    setSaved(null);
    try {
      const data = await send(
        {
          operation: 'review',
          reviewId: retained.id,
          reviewSha256: retained.reviewSha256,
          sessionExpiresAt: selectedDeadline,
        },
        c,
      );
      if (!live(c)) return;
      const admitted = await warmupConsentPreview(
        data,
        plan,
        view,
        retained,
        selectedDeadline,
      );
      if (live(c)) setPrepared(admitted);
    } catch {
      if (live(c))
        setError(
          'Plan approval could not be reviewed. Request a fresh session review or recover an existing approval. No approval was saved.',
        );
    } finally {
      finishOperation(c);
    }
  }
  async function save() {
    if (!fresh || !view || !prepared || !approved || marker || invalidReminder)
      return;
    const c = begin('save');
    if (!c) return;
    let submitted = false;
    try {
      const selection = await warmupConsentSaveSelection(
        prepared,
        plan,
        view,
        retained,
        selectedDeadline,
      );
      if (!live(c)) return;
      const text = JSON.stringify(selection);
      sessionStorage.setItem(storageKey, text);
      if (sessionStorage.getItem(storageKey) !== text)
        throw Error('Could not keep recovery ID');
      setMarker(selection);
      setRecoveryId(selection.id);
      setApproved(false);
      submitted = true;
      const { planId: _planId, ...input } = selection;
      const data = await send(
        { operation: 'save', ...input, approved: true },
        c,
      );
      if (!live(c)) return;
      const result = await warmupConsentSaved(data, selection, view.review);
      if (live(c)) {
        setSaved(result);
        setPrepared(null);
        setMessage(
          'Plan approval saved. No trades started; automatic Start is still unavailable.',
        );
      }
    } catch (cause) {
      if (live(c) && cause instanceof WarmupConsentConflictError) {
        setOriginalId(cause.recoveryId);
        setPrepared(null);
        setError(
          'This review already has an approval under another ID. Recover the original approval below; no second approval was saved.',
        );
      } else if (live(c))
        setError(
          submitted
            ? 'Save outcome is unconfirmed. Recover the same approval ID before another save. No retry was sent.'
            : 'Could not keep or validate the recovery ID. No approval save was sent.',
        );
    } finally {
      finishOperation(c);
    }
  }
  async function recover(original?: string) {
    const selectedId = original ?? recoveryId;
    if (!UUID.test(selectedId) || selectedId !== selectedId.toLowerCase())
      return;
    const c = begin('recover');
    if (!c) return;
    setPrepared(null);
    setApproved(false);
    setSaved(null);
    let missing = false;
    try {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(10000)]);
      const response = await fetch(
        endpoint + '?id=' + encodeURIComponent(selectedId),
        { cache: 'no-store', signal },
      );
      const data = await readWarmupConsentResponse(response, signal);
      if (!live(c)) return;
      if (!response.ok) {
        missing = response.status === 404;
        throw Error('Approval recovery unavailable');
      }
      const result = await warmupConsentSaved(
        data,
        original
          ? {
              id: original,
              planId: plan.id,
              reviewId: marker?.reviewId ?? retained.id,
              reviewSha256: marker?.reviewSha256 ?? retained.reviewSha256,
            }
          : marker?.id === selectedId
            ? marker
            : { id: selectedId, planId: plan.id },
      );
      if (live(c)) {
        if (original) {
          const known: WarmupConsentRecovery = {
            id: result.id,
            planId: plan.id,
            reviewId: result.terms.reviewId,
            reviewSha256: result.terms.reviewSha256,
            sessionExpiresAt: result.terms.sessionExpiresAt,
            termsSha256: result.termsSha256,
          };
          try {
            const text = JSON.stringify(known);
            sessionStorage.setItem(storageKey, text);
            if (sessionStorage.getItem(storageKey) !== text)
              throw Error('Reminder differs');
            setMarker(known);
            setOriginalId(null);
          } catch {
            setError(
              'Original approval recovered, but its local reminder could not be updated. Keep the displayed approval ID.',
            );
          }
          setRecoveryId(result.id);
        }
        setSaved(result);
        setMessage(
          'Recorded plan approval recovered. It does not renew the deadline or start trading.',
        );
      }
    } catch {
      if (live(c))
        setError(
          missing
            ? 'This approval was not found for this account. A missing record does not cancel a save that may still be pending. Keep the ID and recover again.'
            : 'Approval recovery is unavailable. Keep its original ID and try recovering again.',
        );
    } finally {
      finishOperation(c);
    }
  }
  function clear() {
    if (pending.current) return;
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      setError(
        'The local reminder could not be cleared. No server record changed.',
      );
      return;
    }
    setMarker(null);
    setInvalidReminder(false);
    setSaved(null);
    setPrepared(null);
    setApproved(false);
    setOriginalId(null);
    setClearedContext(view?.review.contextKey ?? null);
    setError('');
    setMessage(
      'Local reminder cleared. No server approval was deleted or cancelled. Request a fresh session review before saving another.',
    );
  }
  return (
    <section
      className={styles.panel}
      aria-label="Session plan approval"
      aria-busy={busy}
    >
      <h6>Approve this session plan</h6>
      <p>
        Save your choice for this exact plan. This does not start trades or
        unlock a wallet. Automatic Start is still unavailable.
      </p>
      {!fresh && (
        <p>
          Request and save a fresh session review above before approving a plan.
          Recovery remains available.
        </p>
      )}
      <label className={styles.field}>
        Finish window after the last planned action
        <select
          aria-label="Finish window after the last planned action"
          value={finish}
          disabled={busy || !!marker || invalidReminder || !fresh}
          onChange={(e) => {
            setFinish(Number(e.target.value));
            setPrepared(null);
            setApproved(false);
          }}
        >
          {WARMUP_CONSENT_FINISH_MINUTES.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes} {minutes === 1 ? 'minute' : 'minutes'}
            </option>
          ))}
        </select>
      </label>
      {fresh && selectedDeadline && (
        <p>
          Selected finish deadline:{' '}
          <strong>{new Date(selectedDeadline).toLocaleString()}</strong>.
        </p>
      )}
      <div className={styles.controls}>
        <Button
          variant="outline"
          disabled={
            !fresh ||
            busy ||
            !!marker ||
            invalidReminder ||
            !view?.review.actions.length
          }
          onClick={() => void review()}
        >
          Review plan approval
        </Button>
        {operation !== null && (
          <Button variant="outline" onClick={stop}>
            Stop waiting for approval
          </Button>
        )}
      </div>
      {prepared && (
        <div className={styles.review}>
          <p>
            <strong>{quantity(prepared.summary.actionCount, 'action')}</strong>{' '}
            across {quantity(prepared.summary.walletCount, 'wallet')}. Maximum
            further spend:{' '}
            <strong>
              {formatNativeBalance(
                prepared.summary.maximumNativeSpendLamports,
                9,
              )}{' '}
              SOL
            </strong>
            . Review the exact actions and wallet limits above.
          </p>
          <p>
            Finish by{' '}
            {new Date(prepared.terms.sessionExpiresAt).toLocaleString()}. This
            approval review expires at{' '}
            {new Date(prepared.reviewExpiresAt).toLocaleTimeString()}.
          </p>
          <label className={styles.approval}>
            <input
              type="checkbox"
              checked={approved}
              disabled={busy}
              onChange={(e) => setApproved(e.target.checked)}
            />
            <span>
              I approve this exact saved plan, spending limits and finish
              deadline. I understand this does not start trades.
            </span>
          </label>
          <Button
            disabled={!approved || busy || !fresh || !!marker}
            onClick={() => void save()}
          >
            Save plan approval
          </Button>
        </div>
      )}
      {marker && (
        <p>
          Approval recovery ID: <code>{marker.id}</code>. Keep this ID before
          clearing browser storage. Recover it before saving another approval.
        </p>
      )}
      {originalId && (
        <div className={styles.review}>
          <p>
            Original saved approval: <code>{originalId}</code>. Recovery reads
            its unchanged plan and deadline.
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void recover(originalId)}
          >
            Recover original approval
          </Button>
        </div>
      )}
      <label className={styles.field}>
        Plan approval ID
        <input
          aria-label="Plan approval ID"
          autoComplete="off"
          spellCheck={false}
          maxLength={36}
          value={recoveryId}
          disabled={busy}
          onChange={(e) => {
            setRecoveryId(e.target.value.trim());
            setSaved(null);
            setError('');
          }}
        />
      </label>
      <Button
        variant="outline"
        disabled={
          busy ||
          !UUID.test(recoveryId) ||
          recoveryId !== recoveryId.toLowerCase()
        }
        onClick={() => void recover()}
      >
        Recover plan approval
      </Button>
      {operation && (
        <output>
          {operation === 'review'
            ? 'Reading exact approval terms. No save.'
            : operation === 'save'
              ? 'Saving the approved plan once. No signing or trades.'
              : 'Reading the original approval. No save or deadline renewal.'}
        </output>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <output>{message}</output>}
      {saved && (
        <div className={styles.review}>
          <strong>Recorded plan approval only</strong>
          <p>
            {quantity(saved.summary.actionCount, 'action')},{' '}
            {quantity(saved.summary.walletCount, 'wallet')}, maximum{' '}
            {formatNativeBalance(saved.summary.maximumNativeSpendLamports, 9)}{' '}
            SOL. Finish deadline{' '}
            {new Date(saved.terms.sessionExpiresAt).toLocaleString()}.
          </p>
          <p>
            Saved {new Date(saved.createdAt).toLocaleString()}. No session is
            running and this record cannot authorize signing.
          </p>
          <code>{saved.id}</code>
          <WalletWarmupSessionProgress
            consent={saved}
            onBusyChange={setJournalBusy}
          />
        </div>
      )}
      {(marker || invalidReminder) && (
        <details>
          <summary>Local approval reminder</summary>
          <p>
            Clearing this reminder does not cancel a pending save or delete
            server history. Keep its ID first.
          </p>
          <Button variant="ghost" disabled={busy} onClick={clear}>
            Clear local approval reminder
          </Button>
        </details>
      )}
    </section>
  );
}
