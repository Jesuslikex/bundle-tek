'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  warmupJournalContext,
  warmupJournalRequest,
  warmupJournalRequestBody,
  warmupJournalView,
  readWarmupJournalResponse,
  type WarmupJournalConsent,
  type WarmupJournalRequest,
  type WarmupJournalView,
} from '@/lib/wallet-warmup-session-journal-view';
import { WARMUP_RECEIPT_SAVED } from '@/lib/warmup-receipt-events';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { Button } from './ui/button';
import styles from './wallet-warmup-session-progress.module.css';
const endpoint = '/api/wallet-workspace/warmup/session-journals';
type Props = {
  consent: WarmupJournalConsent;
  onBusyChange: (busy: boolean) => void;
};
export function WalletWarmupSessionProgress(props: Props) {
  return (
    <ProgressPanel
      key={props.consent.id + ':' + props.consent.termsSha256}
      {...props}
    />
  );
}
function ProgressPanel({ consent, onBusyChange }: Props) {
  const context = useMemo(() => {
    try {
      return warmupJournalContext(consent);
    } catch {
      return null;
    }
  }, [consent]);
  const storageKey = 'bundle:warmup-journal-request:' + consent.id;
  const pending = useRef<AbortController | null>(null),
    mounted = useRef(false);
  const previous = useRef<WarmupJournalView | null>(null);
  const [journal, setJournal] = useState<WarmupJournalView | null>(null),
    [marker, setMarker] = useState<WarmupJournalRequest | null>(null),
    [busy, setBusy] = useState(false),
    [checked, setChecked] = useState(false),
    [invalidReminder, setInvalidReminder] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [expired, setExpired] = useState(false);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    const invalidate = () => {
      pending.current?.abort();
      pending.current = null;
      setBusy(false);
      setChecked(false);
      setMessage(
        'Status needs refresh. Recover any pending request before another change.',
      );
    };
    const receipt = (event: Event) => {
      if ((event as CustomEvent).detail?.planId === context?.planId)
        invalidate();
    };
    window.addEventListener('pagehide', invalidate);
    window.addEventListener('storage', invalidate);
    window.addEventListener(WARMUP_RECEIPT_SAVED, receipt);
    return () => {
      window.removeEventListener('pagehide', invalidate);
      window.removeEventListener('storage', invalidate);
      window.removeEventListener(WARMUP_RECEIPT_SAVED, receipt);
    };
  }, [context?.planId]);
  useEffect(() => {
    if (!journal) return;
    const left = Date.parse(journal.effectiveReviewExpiresAt) - Date.now();
    const timer = setTimeout(() => setExpired(true), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [journal]);
  const live = useCallback(
    (c: AbortController) =>
      mounted.current && pending.current === c && !c.signal.aborted,
    [],
  );
  const remember = useCallback(
    (request: WarmupJournalRequest) => {
      sessionStorage.setItem(storageKey, JSON.stringify(request));
      setMarker(request);
    },
    [storageKey],
  );
  const forget = useCallback(() => {
    sessionStorage.removeItem(storageKey);
    setMarker(null);
  }, [storageKey]);
  const loadReminder = useCallback(() => {
    if (!context) return null;
    const raw = sessionStorage.getItem(storageKey);
    const request = raw ? warmupJournalRequest(JSON.parse(raw), context) : null;
    setMarker(request);
    return request;
  }, [context, storageKey]);
  const exchange = useCallback(
    async (write: WarmupJournalRequest | null) => {
      if (!context || pending.current) return;
      const c = new AbortController();
      pending.current = c;
      setBusy(true);
      setError('');
      setMessage('');
      const timer = setTimeout(() => c.abort(), 15000);
      let request = write;
      try {
        if (write) {
          // A reminder is persisted before the only POST attempt.
          remember(warmupJournalRequest(write, context));
        } else {
          try {
            request = loadReminder();
            setInvalidReminder(false);
          } catch {
            setInvalidReminder(true);
            request = null;
          }
        }
        const query = new URLSearchParams({ consentId: context.consentId });
        if (!write && request?.kind === 'control')
          query.set('eventId', request.id);
        const response = await fetch(
          write ? endpoint : endpoint + '?' + query.toString(),
          {
            ...(write
              ? {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(warmupJournalRequestBody(write)),
                }
              : {}),
            cache: 'no-store',
            credentials: 'same-origin',
            signal: c.signal,
          },
        );
        const value = await readWarmupJournalResponse(response, c.signal);
        if (!live(c)) return;
        if (!response.ok) {
          if (
            !write &&
            response.status === 404 &&
            !previous.current &&
            request?.kind !== 'control'
          ) {
            setJournal(null);
            setChecked(true);
            setMessage(
              request
                ? 'No saved result is confirmed yet. Recover again or retry this same history request.'
                : 'No session history saved yet. Saving history does not start trades.',
            );
            return;
          }
          throw Error(
            response.status === 401
              ? 'Sign in again, then recover saved status.'
              : response.status === 409
                ? 'Saved status changed. Recover the original request before another change.'
                : 'Saved status could not be confirmed. Recover the original request before another change.',
          );
        }
        const admitted = await warmupJournalView(value, context, {
          ...(previous.current ? { previous: previous.current } : {}),
          ...(write?.kind === 'record' ? { id: write.id } : {}),
          ...(request?.kind === 'control'
            ? { id: request.journalId, request, requireReceipt: write !== null }
            : {}),
        });
        if (!live(c)) return;
        previous.current = admitted;
        setJournal(admitted);
        setChecked(true);
        setExpired(Date.now() >= Date.parse(admitted.effectiveReviewExpiresAt));
        if (request?.kind === 'control' && !admitted.commandReceipt) {
          setMessage(
            'This request is not confirmed in saved history. Recover again before deciding what to do next.',
          );
        } else {
          if (request) forget();
          setMessage(
            write
              ? 'Session history saved. No signing or trades were started.'
              : 'Saved status recovered. No request was sent to a wallet or trading provider.',
          );
        }
      } catch (cause) {
        if (mounted.current && pending.current === c) {
          setChecked(false);
          setError(
            c.signal.aborted
              ? 'Request ended before its result was confirmed. Recover the same request; nothing is retried automatically.'
              : cause instanceof Error &&
                  [
                    'Sign in again, then recover saved status.',
                    'Saved status changed. Recover the original request before another change.',
                    'Saved status could not be confirmed. Recover the original request before another change.',
                  ].includes(cause.message)
                ? cause.message
                : 'Saved status is unavailable or differs. Refresh saved status before another change.',
          );
        }
      } finally {
        clearTimeout(timer);
        if (pending.current === c) {
          pending.current = null;
          if (mounted.current) setBusy(false);
        }
      }
    },
    [context, live, remember, forget, loadReminder],
  );
  useEffect(() => {
    mounted.current = true;
    void Promise.resolve().then(() => {
      if (mounted.current) void exchange(null);
    });
    return () => {
      mounted.current = false;
      pending.current?.abort();
      pending.current = null;
    };
  }, [exchange]);
  async function refresh() {
    await exchange(null);
  }
  function write(control?: 'pause' | 'resume' | 'stop') {
    if (!context || busy || !checked || marker || invalidReminder) return;
    const request: WarmupJournalRequest = {
      format: 'warmup-journal-request-v1',
      consentId: context.consentId,
      termsSha256: context.termsSha256,
      id: crypto.randomUUID(),
      ...(control && journal
        ? {
            kind: 'control',
            journalId: journal.id,
            control,
            expectedVersion: journal.version,
            expectedHeadSha256: journal.headSha256,
          }
        : { kind: 'record' }),
    };
    void exchange(request);
  }
  function cancel() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setChecked(false);
    setMessage(
      'Request cancelled locally. Recover its saved result before another change.',
    );
  }
  const conflictResolved =
    marker?.kind === 'control' &&
    journal !== null &&
    checked &&
    journal.version > marker.expectedVersion &&
    journal.commandReceipt === null;
  function continueFromSaved() {
    if (!conflictResolved || busy) return;
    try {
      forget();
      setMessage(
        'Saved status is newer. Review it before choosing a new control.',
      );
    } catch {
      setError(
        'The browser reminder could not be cleared. Keep recovering the original request.',
      );
    }
  }
  function clearReminder() {
    if (!checked || busy) return;
    try {
      forget();
      setInvalidReminder(false);
      setChecked(false);
      setMessage(
        'Local reminder cleared. This does not cancel a server request. Refresh saved status before another change.',
      );
    } catch {
      setError(
        'The browser reminder could not be cleared. Keep its request ID and recover saved status.',
      );
    }
  }
  const s = journal?.snapshot;
  const label = !s
    ? 'No session history yet'
    : s.phase === 'complete'
      ? 'Recorded session complete'
      : s.pending?.state === 'unknown'
        ? 'Recovery required'
        : s.stopped
          ? 'Plan stopped'
          : s.pending
            ? 'Action needs recovery'
            : s.paused
              ? 'Plan paused'
              : expired || !s.sourceReviewFresh || s.reviewWindowUnavailable
                ? 'Fresh review required'
                : 'Ready for review';
  if (!context)
    return (
      <p role="alert">
        This saved approval is unavailable. Recover it before opening session
        history.
      </p>
    );
  return (
    <section className={styles.panel} aria-label="Warmup session history">
      <div className={styles.heading}>
        <div>
          <h6>Session progress</h6>
          <p>{label}</p>
        </div>
        <span className={styles.badge}>Automatic activity off</span>
      </div>
      <p>History and plan controls only. Automatic signing is not enabled.</p>
      {journal && s && (
        <>
          <div className={styles.progress}>
            <strong>
              {s.completedActions} of {s.totalActions} actions recorded
            </strong>
            <progress
              aria-label="Recorded session actions"
              value={s.completedActions}
              max={s.totalActions}
            />
          </div>
          <p>
            {expired || !s.sourceReviewFresh
              ? 'Review expired at'
              : 'Review available until'}{' '}
            {new Date(journal.effectiveReviewExpiresAt).toLocaleTimeString()}.
            Approved finish{' '}
            {new Date(journal.sessionExpiresAt).toLocaleString()}.
          </p>
          {s.pending && (
            <output>
              {s.pending.action.side} action for wallet{' '}
              {s.pending.action.wallet.slice(0, 5)}…
              {s.pending.action.wallet.slice(-4)} is retained. Stop does not
              erase a pending outcome.
            </output>
          )}
          <div className={styles.wallets}>
            {s.wallets.map((w) => (
              <article key={w.wallet} className={styles.wallet}>
                <strong title={w.wallet}>
                  {w.wallet.slice(0, 5)}…{w.wallet.slice(-4)}
                </strong>
                <dl>
                  <div>
                    <dt>Buy spending</dt>
                    <dd>
                      {formatNativeBalance(
                        w.recordedFurtherBuySpendLamports,
                        9,
                      )}{' '}
                      SOL
                    </dd>
                  </div>
                  <div>
                    <dt>Recorded fees and rent</dt>
                    <dd>
                      {formatNativeBalance(w.recordedFurtherFeeRentLamports, 9)}{' '}
                      SOL
                    </dd>
                  </div>
                  <div>
                    <dt>Fee budget remaining</dt>
                    <dd>
                      {formatNativeBalance(w.remainingReserveLamports, 9)} SOL
                    </dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
          <p className={styles.note}>
            Amounts are recorded against this plan’s approved budget. Check
            wallet balances separately before trading.
          </p>
        </>
      )}
      <div className={styles.controls}>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {marker ? 'Recover request' : 'Refresh saved status'}
        </Button>
        {!journal && (
          <Button
            disabled={busy || !checked || !!marker || invalidReminder}
            onClick={() => write()}
          >
            Save session history
          </Button>
        )}
        {s && !s.stopped && (
          <>
            <Button
              variant="outline"
              disabled={
                busy ||
                !checked ||
                !!marker ||
                invalidReminder ||
                s.phase === 'complete'
              }
              onClick={() => write(s.paused ? 'resume' : 'pause')}
            >
              {s.paused ? 'Resume plan' : 'Pause plan'}
            </Button>
            <Button
              variant="outline"
              disabled={
                busy ||
                !checked ||
                !!marker ||
                invalidReminder ||
                s.phase === 'complete'
              }
              onClick={() => write('stop')}
            >
              Stop plan
            </Button>
          </>
        )}
        <Button disabled>Start automatic activity</Button>
        {busy && (
          <Button variant="ghost" onClick={cancel}>
            Cancel status request
          </Button>
        )}
      </div>
      <p className={styles.note}>
        Automatic activity is unavailable in this release. Saving, pausing or
        resuming a plan does not start trades.
      </p>
      {busy && (
        <output>Checking or saving session history. No wallet request.</output>
      )}
      {message && <output>{message}</output>}
      {error && <p role="alert">{error}</p>}
      {(marker || invalidReminder) && (
        <div className={styles.recovery}>
          <strong>Request needs recovery</strong>
          <p>
            Recover saved status first. A retry uses the same history request ID
            and never calls a wallet.
          </p>
          {marker && (
            <Button
              variant="outline"
              disabled={
                busy || !checked || invalidReminder || !!conflictResolved
              }
              onClick={() => void exchange(marker)}
            >
              Retry this history request
            </Button>
          )}
          {conflictResolved && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={continueFromSaved}
            >
              Continue from saved status
            </Button>
          )}
          {invalidReminder && (
            <p>
              The local reminder could not be read. Keep any request ID from
              recovery details before clearing browser storage.
            </p>
          )}
        </div>
      )}
      <details>
        <summary>Recovery details</summary>
        <p>
          Approval: <code>{context.consentId}</code>
        </p>
        {journal && (
          <p>
            Session: <code>{journal.id}</code> · Saved version {journal.version}
          </p>
        )}
        {marker && (
          <p>
            Pending request: <code>{marker.id}</code>. Keep this ID if browser
            storage is cleared.
          </p>
        )}
        {(marker || invalidReminder) && (
          <>
            <p>
              Keep any request ID first. Clearing the local reminder does not
              cancel server work.
            </p>
            <Button
              variant="ghost"
              disabled={busy || !checked}
              onClick={clearReminder}
            >
              Clear local session reminder
            </Button>
          </>
        )}
      </details>
    </section>
  );
}
