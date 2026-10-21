'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  readWarmupJournalResponse,
  type WarmupJournalContext,
  type WarmupJournalView,
} from '@/lib/wallet-warmup-session-journal-view';
import {
  warmupPreparationRequest,
  warmupPreparationIdentity,
  warmupPreparationRequestBody,
  type WarmupPreparationRequest,
} from '@/lib/wallet-warmup-session-preparation-request';
import { warmupPreparationView } from '@/lib/wallet-warmup-session-preparation-view';
import { WARMUP_RECEIPT_SAVED } from '@/lib/warmup-receipt-events';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { Button } from './ui/button';
import styles from './wallet-warmup-session-preparation.module.css';

const endpoint = '/api/wallet-workspace/warmup/session-preparations';
type Props = {
  journal: WarmupJournalView;
  context: WarmupJournalContext;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
};
type Prepared = ReturnType<typeof warmupPreparationView>;
const collision = z
  .object({ error: z.string().max(1024), recoveryId: z.uuid() })
  .strict();

export function WalletWarmupSessionPreparation({
  journal,
  context,
  disabled,
  onBusyChange,
}: Props) {
  const key = 'bundle:warmup-preparation-request:' + context.consentId;
  const pending = useRef<AbortController | null>(null),
    mounted = useRef(false),
    head = useRef(journal.headSha256),
    starting = useRef(false),
    generation = useRef(0);
  const [marker, setMarker] = useState<WarmupPreparationRequest | null>(null),
    [result, setResult] = useState<Prepared | null>(null),
    [busy, setBusy] = useState(false),
    [approved, setApproved] = useState(false),
    [loaded, setLoaded] = useState(false),
    [retryReady, setRetryReady] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [recoveryId, setRecoveryId] = useState<string | null>(null),
    [now, setNow] = useState(Date.now);
  const live = useCallback(
    (c: AbortController) =>
      mounted.current && pending.current === c && !c.signal.aborted,
    [],
  );
  const changeBusy = useCallback(
    (value: boolean) => {
      setBusy(value);
      onBusyChange(value);
    },
    [onBusyChange],
  );
  const cancel = useCallback(() => {
    const wasPending = !!pending.current || starting.current;
    generation.current++;
    pending.current?.abort();
    pending.current = null;
    changeBusy(false);
    setApproved(false);
    setRetryReady(false);
    if (wasPending)
      setMessage(
        'Request ended locally. Recover its original ID before another attempt. Server work may already have completed.',
      );
  }, [changeBusy]);
  const persist = useCallback(
    (m: WarmupPreparationRequest) => {
      setMarker(m);
      const text = JSON.stringify(m);
      sessionStorage.setItem(key, text);
      if (sessionStorage.getItem(key) !== text)
        throw Error('Reminder not retained');
    },
    [key],
  );
  const exchange = useCallback(
    async (m: WarmupPreparationRequest, write: boolean) => {
      if (pending.current) return;
      const c = new AbortController();
      pending.current = c;
      changeBusy(true);
      setRetryReady(false);
      setError('');
      setMessage('');
      setRecoveryId(null);
      setApproved(false);
      const timeout = setTimeout(() => c.abort(), 30000);
      try {
        const original = await warmupPreparationRequest(m, context);
        if (!live(c)) return;
        if (write) persist(original);
        const response = await fetch(
          write
            ? endpoint
            : endpoint + '?id=' + encodeURIComponent(original.id),
          {
            ...(write
              ? {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(warmupPreparationRequestBody(original)),
                }
              : {}),
            credentials: 'same-origin',
            cache: 'no-store',
            signal: c.signal,
          },
        );
        const value = await readWarmupJournalResponse(response, c.signal);
        if (!live(c)) return;
        if (!response.ok) {
          if (!write && response.status === 404) {
            setRetryReady(true);
            setMessage(
              'No saved result is confirmed for this ID yet. You may recover again. A retry, if still fresh, keeps this exact request and review head.',
            );
            return;
          }
          const conflict = collision.safeParse(value);
          if (response.status === 409 && conflict.success)
            setRecoveryId(conflict.data.recoveryId);
          throw Error(
            response.status === 401
              ? 'Sign in again, then recover the original preparation.'
              : response.status === 429
                ? 'The provider is rate limited. Wait at least 30 seconds, then recover the original request. Nothing is retried automatically.'
                : 'Preparation could not be confirmed. Recover the original request before another attempt.',
          );
        }
        const admitted = warmupPreparationView(
          value,
          warmupPreparationIdentity(original),
          original.journal,
          context,
        );
        if (!live(c)) return;
        setResult(admitted);
        setApproved(false);
        setMessage(
          'Unsigned preparation recovered. No wallet was unlocked, signed or sent.',
        );
      } catch (cause) {
        if (mounted.current && pending.current === c) {
          setApproved(false);
          const known = [
            'Sign in again, then recover the original preparation.',
            'The provider is rate limited. Wait at least 30 seconds, then recover the original request. Nothing is retried automatically.',
          ];
          setError(
            cause instanceof Error && known.includes(cause.message)
              ? cause.message
              : 'Preparation could not be confirmed. Keep the original ID and recover; nothing is retried automatically.',
          );
        }
      } finally {
        clearTimeout(timeout);
        if (pending.current === c) {
          pending.current = null;
          if (mounted.current) changeBusy(false);
        }
      }
    },
    [context, changeBusy, live, persist],
  );
  useEffect(() => {
    mounted.current = true;
    const c = new AbortController();
    void (async () => {
      try {
        const raw = sessionStorage.getItem(key);
        const saved = raw
          ? await warmupPreparationRequest(JSON.parse(raw), context)
          : null;
        if (c.signal.aborted || !mounted.current) return;
        setMarker(saved);
        setLoaded(true);
        if (saved) void exchange(saved, false);
      } catch {
        if (!c.signal.aborted && mounted.current) {
          setError(
            'The preparation reminder could not be read. Keep the original ID; no new preparation is allowed.',
          );
          setLoaded(false);
        }
      }
    })();
    return () => {
      c.abort();
      mounted.current = false;
      pending.current?.abort();
      pending.current = null;
      onBusyChange(false);
    };
  }, [context, key, exchange, onBusyChange]);
  useEffect(() => {
    if (head.current !== journal.headSha256) {
      head.current = journal.headSha256;
      cancel();
    }
  }, [journal.headSha256, cancel]);
  useEffect(() => {
    const receipt = (event: Event) => {
      if ((event as CustomEvent).detail?.planId === context.planId) cancel();
    };
    window.addEventListener('pagehide', cancel);
    window.addEventListener('storage', cancel);
    window.addEventListener(WARMUP_RECEIPT_SAVED, receipt);
    return () => {
      window.removeEventListener('pagehide', cancel);
      window.removeEventListener('storage', cancel);
      window.removeEventListener(WARMUP_RECEIPT_SAVED, receipt);
    };
  }, [cancel, context.planId]);
  const deadline =
    result?.effectiveReviewExpiresAt ?? journal.effectiveReviewExpiresAt;
  useEffect(() => {
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(deadline) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [deadline]);
  const expired = now >= Date.parse(deadline);
  const action = journal.snapshot.pending?.action;
  const displayAction = marker?.journal.snapshot.pending?.action ?? action;
  const fresh =
    !expired &&
    journal.snapshot.sourceReviewFresh &&
    !journal.snapshot.paused &&
    !journal.snapshot.stopped &&
    journal.snapshot.pending?.state === 'reviewing';
  const sameHead =
    !marker ||
    (marker.journal.id === journal.id &&
      marker.journal.version === journal.version &&
      marker.journal.headSha256 === journal.headSha256);
  async function prepare() {
    if (
      starting.current ||
      disabled ||
      busy ||
      !loaded ||
      !approved ||
      !fresh ||
      Date.now() >= Date.parse(journal.effectiveReviewExpiresAt) ||
      !sameHead ||
      result ||
      recoveryId ||
      (marker && !retryReady)
    )
      return;
    starting.current = true;
    changeBusy(true);
    const captured = generation.current;
    try {
      const original =
        marker ??
        (await warmupPreparationRequest(
          {
            format: 'warmup-preparation-request-v1',
            id: crypto.randomUUID(),
            consentId: context.consentId,
            termsSha256: context.termsSha256,
            journal: { ...journal, commandReceipt: null },
          },
          context,
        ));
      if (
        !mounted.current ||
        captured !== generation.current ||
        head.current !== journal.headSha256 ||
        pending.current
      )
        return;
      await exchange(original, true);
    } finally {
      starting.current = false;
      if (!pending.current) changeBusy(false);
    }
  }
  if (!action && !marker && !error) return null;
  return (
    <section
      className={styles.panel}
      aria-label="Unsigned warmup preparation"
      aria-busy={busy}
    >
      <div>
        <h6>Review this action</h6>
        <p>
          Quote and simulation only. Signing and automatic activity remain off.
        </p>
      </div>
      {displayAction && (
        <p>
          {displayAction.side} · Cycle {displayAction.cycle} · Wallet{' '}
          {displayAction.wallet.slice(0, 5)}…{displayAction.wallet.slice(-4)}
        </p>
      )}
      {!sameHead && (
        <p>
          The current session has changed. This saved request belongs to the
          earlier review; recovery does not start a new action.
        </p>
      )}
      {!result && fresh && sameHead && !recoveryId && (
        <label className={styles.consent}>
          <input
            type="checkbox"
            checked={approved}
            disabled={busy || disabled || !loaded}
            onChange={(e) => setApproved(e.target.checked)}
          />
          Request an unsigned quote and simulation for this action. This does
          not approve signing or spending.
        </label>
      )}
      {!result && !fresh && (
        <p>
          A fresh, unpaused action review is needed for a new preparation. Saved
          preparations can still be recovered.
        </p>
      )}
      {result && (
        <div className={styles.review}>
          <strong>
            {expired
              ? 'Saved unsigned preparation · expired'
              : 'Saved unsigned preparation'}
          </strong>
          <dl>
            <div>
              <dt>Input</dt>
              <dd>
                {result.side === 'Buy'
                  ? formatNativeBalance(result.inAmountRaw, 9) + ' SOL'
                  : result.inAmountRaw + ' token base units'}
              </dd>
            </div>
            <div>
              <dt>Expected output</dt>
              <dd>
                {result.side === 'Sell'
                  ? formatNativeBalance(result.quotedOutRaw, 9) + ' SOL'
                  : result.quotedOutRaw + ' token base units'}
              </dd>
            </div>
            <div>
              <dt>Minimum output</dt>
              <dd>
                {result.side === 'Sell'
                  ? formatNativeBalance(result.minimumOutRaw, 9) + ' SOL'
                  : result.minimumOutRaw + ' token base units'}
              </dd>
            </div>
            <div>
              <dt>Provider fee estimate</dt>
              <dd>
                {formatNativeBalance(result.estimatedFeesLamports, 9)} SOL
              </dd>
            </div>
            <div>
              <dt>Simulated network fee</dt>
              <dd>
                {formatNativeBalance(result.simulation.networkFeeLamports, 9)}{' '}
                SOL
              </dd>
            </div>
            <div>
              <dt>Review expires</dt>
              <dd>
                {new Date(result.effectiveReviewExpiresAt).toLocaleString()}
              </dd>
            </div>
            <div>
              <dt>Unsigned packet</dt>
              <dd>
                {result.packetAvailability === 'retained'
                  ? 'Retained privately'
                  : result.packetAvailability === 'summary-only'
                    ? 'Summary only'
                    : 'Storage unavailable'}
              </dd>
            </div>
          </dl>
          <p>
            Fee values are provisional and are not additive. They do not
            establish total cost, exact rent or spending clearance.
          </p>
          <p>{result.limitations}</p>
        </div>
      )}
      <div className={styles.controls}>
        {!result && (
          <Button
            disabled={
              disabled ||
              busy ||
              !loaded ||
              !approved ||
              !fresh ||
              !sameHead ||
              !!recoveryId ||
              (!!marker && !retryReady)
            }
            onClick={() => {
              void prepare().catch(() =>
                setError(
                  'Original review unavailable. Refresh saved status before another attempt.',
                ),
              );
            }}
          >
            {marker
              ? 'Retry this preparation request'
              : 'Prepare unsigned action'}
          </Button>
        )}
        {marker && (
          <Button
            variant="outline"
            disabled={busy || disabled}
            onClick={() => void exchange(marker, false)}
          >
            Recover saved preparation
          </Button>
        )}
        {busy && (
          <Button variant="ghost" onClick={cancel}>
            Cancel preparation request
          </Button>
        )}
      </div>
      {message && <output>{message}</output>}
      {error && <p role="alert">{error}</p>}
      {recoveryId && (
        <p role="alert">
          An earlier preparation already exists. Keep its ID in recovery details
          and recover with its original review context. No replacement will be
          created here.
        </p>
      )}
      {marker && (
        <details>
          <summary>Preparation recovery details</summary>
          <p>
            Request: <code>{marker.id}</code>
          </p>
          {recoveryId && (
            <p>
              Earlier preparation: <code>{recoveryId}</code>
            </p>
          )}
          <p>
            Original review version {marker.journal.version}. Keep this browser
            reminder. A recovery read never renews the review or sends a
            transaction.
          </p>
          {result && (
            <p>
              Token mint: <code>{result.mint}</code>
            </p>
          )}
        </details>
      )}
    </section>
  );
}
