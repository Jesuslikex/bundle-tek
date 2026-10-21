'use client';
import { useCallback, useEffect, useRef, useState, useId } from 'react';
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
import { warmupPreparationRecoveryView } from '@/lib/wallet-warmup-session-preparation-recovery-view';
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
  onRecovered?: (journal: WarmupJournalView) => void;
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
  onRecovered,
}: Props) {
  const recoveryInputId = useId();
  const key = 'bundle:warmup-preparation-request:' + context.consentId;
  const pending = useRef<AbortController | null>(null),
    mounted = useRef(false),
    head = useRef(journal.headSha256),
    starting = useRef(false),
    generation = useRef(0);
  const resultFocus = useRef<HTMLFieldSetElement>(null);
  const [marker, setMarker] = useState<WarmupPreparationRequest | null>(null),
    [result, setResult] = useState<Prepared | null>(null),
    [busy, setBusy] = useState(false),
    [approved, setApproved] = useState(false),
    [loaded, setLoaded] = useState(false),
    [retryReady, setRetryReady] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [recoveryId, setRecoveryId] = useState<string | null>(null),
    [unreadableId, setUnreadableId] = useState<string | null>(null),
    [recoveryInput, setRecoveryInput] = useState(''),
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
        if (response.status === 401 || response.status === 429) {
          void response.body?.cancel().catch(() => {});
          throw Error(
            response.status === 401
              ? 'Sign in again, then recover the original preparation.'
              : 'The provider is rate limited. Wait at least 30 seconds, then recover the original request. Nothing is retried automatically.',
          );
        }
        const value = await readWarmupJournalResponse(response, c.signal);
        if (!live(c)) return;
        if (!response.ok) {
          if (!write && response.status === 404) {
            setRetryReady(!original.recovered);
            setMessage(
              original.recovered
                ? 'The confirmed saved review is currently unavailable. Keep its original ID and recover again. It cannot be retried as a new preparation.'
                : 'No saved result is confirmed for this ID yet. You may recover again. A retry, if still fresh, keeps this exact request and review head.',
            );
            return;
          }
          const conflict = collision.safeParse(value);
          if (response.status === 409 && conflict.success) {
            setRecoveryId(conflict.data.recoveryId);
            persist({
              ...original,
              format: 'warmup-preparation-request-v2',
              recoveryId: conflict.data.recoveryId,
            });
          }
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
          write
            ? 'Unsigned preparation saved. No wallet was unlocked, signed or sent.'
            : 'Unsigned preparation recovered. No wallet was unlocked, signed or sent.',
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
  const recoverContext = useCallback(
    async (value: string | null) => {
      if (disabled || pending.current || starting.current) return;
      const selected =
        value === null
          ? null
          : z
              .uuid()
              .refine((v) => v === v.toLowerCase())
              .safeParse(value.trim());
      if (selected && !selected.success) {
        setError('Enter the original lower-case preparation ID.');
        return;
      }
      const requestedId = selected?.success ? selected.data : null;
      const c = new AbortController();
      pending.current = c;
      changeBusy(true);
      setApproved(false);
      setRetryReady(false);
      setError('');
      setMessage('');
      const timer = setTimeout(() => c.abort(), 30000);
      try {
        const response = await fetch(
          endpoint +
            '/recovery?' +
            (requestedId
              ? 'id=' + encodeURIComponent(requestedId)
              : 'journalId=' + encodeURIComponent(journal.id)),
          { credentials: 'same-origin', cache: 'no-store', signal: c.signal },
        );
        if (response.status === 401 || response.status === 429) {
          void response.body?.cancel().catch(() => {});
          throw Error(
            response.status === 401
              ? 'Sign in again, then recover the saved preparation context.'
              : 'Saved-context recovery is rate limited. Wait and recover again; no new quote was requested.',
          );
        }
        const body = await readWarmupJournalResponse(response, c.signal);
        if (!live(c)) return;
        if (response.status === 404 && !requestedId) {
          setMessage(
            'No saved preparation is confirmed for this action. Keep any existing ID and recover again; no new quote was created.',
          );
          return;
        }
        if (!response.ok) throw Error();
        const oldId = marker?.id ?? unreadableId ?? undefined;
        const recovered = await warmupPreparationRecoveryView(
          body,
          {
            ...(requestedId
              ? { id: requestedId }
              : { discover: true as const }),
            journal,
            ...(oldId && oldId !== requestedId
              ? { priorRequestId: oldId }
              : {}),
          },
          context,
        );
        if (!live(c)) return;
        setResult(recovered.preparation);
        setRecoveryId(null);
        setRecoveryInput('');
        try {
          persist(recovered.request);
          setLoaded(true);
          setUnreadableId(null);
        } catch {
          setError(
            'Saved review verified, but its browser reminder could not be retained. Keep the recovered ID; no retry or new preparation is allowed here.',
          );
        }
        onRecovered?.(recovered.current);
        setMessage(
          'Original unsigned review recovered from saved history. Its expiry is unchanged. No new quote, signature or transaction was requested.',
        );
      } catch (cause) {
        if (mounted.current && pending.current === c)
          setError(
            cause instanceof Error &&
              [
                'Sign in again, then recover the saved preparation context.',
                'Saved-context recovery is rate limited. Wait and recover again; no new quote was requested.',
              ].includes(cause.message)
              ? cause.message
              : 'Saved recovery context could not be confirmed for this plan approval. Keep the ID and recover again; nothing was renewed or sent.',
          );
      } finally {
        clearTimeout(timer);
        if (pending.current === c) {
          pending.current = null;
          if (mounted.current) changeBusy(false);
        }
      }
    },
    [
      disabled,
      changeBusy,
      live,
      marker,
      unreadableId,
      journal,
      context,
      persist,
      onRecovered,
    ],
  );
  useEffect(() => {
    mounted.current = true;
    const c = new AbortController();
    let displayId: string | null = null;
    void (async () => {
      try {
        const raw = sessionStorage.getItem(key);
        if (raw && raw.length <= 81920) {
          const display = z
            .object({ id: z.uuid() })
            .loose()
            .safeParse(JSON.parse(raw));
          if (display.success) displayId = display.data.id;
        }
        const saved = raw
          ? await warmupPreparationRequest(JSON.parse(raw), context)
          : null;
        if (c.signal.aborted || !mounted.current) return;
        setMarker(saved);
        setRecoveryId(saved?.recoveryId ?? null);
        setLoaded(true);
        if (saved) void exchange(saved, false);
      } catch {
        if (!c.signal.aborted && mounted.current) {
          setUnreadableId(displayId);
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
    const storage = (event: StorageEvent) => {
      try {
        if (
          event.storageArea === sessionStorage &&
          (event.key === key || event.key === null)
        )
          cancel();
      } catch {
        cancel();
      }
    };
    window.addEventListener('pagehide', cancel);
    window.addEventListener('storage', storage);
    window.addEventListener(WARMUP_RECEIPT_SAVED, receipt);
    return () => {
      window.removeEventListener('pagehide', cancel);
      window.removeEventListener('storage', storage);
      window.removeEventListener(WARMUP_RECEIPT_SAVED, receipt);
    };
  }, [cancel, context.planId, key]);
  const deadline =
    result?.effectiveReviewExpiresAt ?? journal.effectiveReviewExpiresAt;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      if (current < Date.parse(deadline))
        timer = setTimeout(tick, Math.max(1, Date.parse(deadline) - current));
    };
    timer = setTimeout(tick, Math.max(0, Date.parse(deadline) - Date.now()));
    return () => clearTimeout(timer);
  }, [deadline]);
  useEffect(() => {
    if (result) resultFocus.current?.focus();
  }, [result]);
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
      (marker && !retryReady) ||
      marker?.recovered
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
            format: 'warmup-preparation-request-v2',
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
    } catch {
      if (mounted.current && captured === generation.current)
        setError(
          'Original review unavailable. Refresh saved status before another attempt.',
        );
    } finally {
      starting.current = false;
      if (
        mounted.current &&
        captured === generation.current &&
        !pending.current
      )
        changeBusy(false);
    }
  }
  function retireAbsent() {
    if (
      disabled ||
      busy ||
      !marker ||
      !retryReady ||
      sameHead ||
      result ||
      recoveryId ||
      marker.recovered
    )
      return;
    try {
      sessionStorage.removeItem(key);
      if (sessionStorage.getItem(key) !== null) throw Error();
      setMarker(null);
      setApproved(false);
      setRetryReady(false);
      setError('');
      setMessage(
        'Absent local request retired. This does not cancel server work. Review the current action before requesting again.',
      );
    } catch {
      setError(
        'The original reminder could not be retired. Keep its ID and recover before another preparation.',
      );
    }
  }
  return (
    <section
      className={styles.panel}
      aria-label="Unsigned warmup preparation"
      aria-busy={busy}
    >
      {(displayAction || marker || error) && (
        <div>
          <h6>
            {displayAction
              ? marker?.recovered
                ? 'Recovered unsigned action'
                : 'Review this action'
              : 'Saved preparation recovery'}
          </h6>
          <p>
            {marker?.recovered || !displayAction
              ? 'Saved-only recovery. No new quote, signing or sending.'
              : 'Quote and simulation only. Signing and automatic activity remain off.'}
          </p>
        </div>
      )}
      {displayAction && (
        <p>
          {displayAction.side} · Cycle {displayAction.cycle} · Wallet{' '}
          <span title={displayAction.wallet}>
            {displayAction.wallet.slice(0, 5)}…{displayAction.wallet.slice(-4)}
          </span>
        </p>
      )}
      {displayAction && (
        <p>
          Token mint: <code>{displayAction.mint}</code>
        </p>
      )}
      {!sameHead && (
        <p>
          The current session has changed. This saved request belongs to the
          earlier review; recovery does not start a new action.
        </p>
      )}
      {!result && fresh && sameHead && !recoveryId && !marker?.recovered && (
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
      {!result && !fresh && (action || marker) && (
        <p>
          A fresh, unpaused action review is needed for a new preparation. Saved
          preparations can still be recovered.
        </p>
      )}
      {result && (
        <fieldset
          className={styles.review}
          ref={resultFocus}
          tabIndex={-1}
          aria-label="Saved unsigned preparation review"
        >
          <legend>
            <strong>
              {expired
                ? 'Saved unsigned preparation · expired'
                : 'Saved unsigned preparation'}
            </strong>
          </legend>
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
              <dt>Provider network, priority and rent estimate</dt>
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
        </fieldset>
      )}
      <div className={styles.controls}>
        {!result && (action || marker) && (
          <Button
            disabled={
              disabled ||
              busy ||
              !loaded ||
              !approved ||
              !fresh ||
              !sameHead ||
              !!recoveryId ||
              !!marker?.recovered ||
              (!!marker && !retryReady)
            }
            onClick={() => {
              void prepare();
            }}
          >
            {marker?.recovered
              ? 'Recovered preparation · read only'
              : marker
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
      {busy && (
        <output>
          Checking an unsigned preparation. No signing or sending.
        </output>
      )}
      {message && <output>{message}</output>}
      {error && <p role="alert">{error}</p>}
      {recoveryId && (
        <p role="alert">
          An earlier preparation already exists. Keep its ID in recovery details
          and recover with its original review context. No replacement will be
          created here.
        </p>
      )}
      {recoveryId && !result && (
        <Button
          type="button"
          variant="outline"
          disabled={busy || disabled}
          onClick={() => void recoverContext(recoveryId)}
        >
          Recover earlier preparation
        </Button>
      )}
      {marker &&
        !marker.recovered &&
        retryReady &&
        !sameHead &&
        !result &&
        !recoveryId && (
          <div>
            <p>
              The original GET found no saved preparation and the session head
              has changed. Keep request ID <code>{marker.id}</code> before
              retiring its local reminder. Retiring does not cancel server work.
            </p>
            <Button
              variant="outline"
              disabled={disabled || busy}
              onClick={retireAbsent}
            >
              Retire absent request
            </Button>
          </div>
        )}
      {!result && (
        <Button
          type="button"
          variant="outline"
          disabled={busy || disabled}
          onClick={() => void recoverContext(null)}
        >
          Find saved preparation
        </Button>
      )}
      <details>
        <summary>Recover by saved preparation ID</summary>
        <label htmlFor={recoveryInputId}>Preparation ID</label>
        <input
          id={recoveryInputId}
          className={styles.recoveryInput}
          value={recoveryInput}
          maxLength={64}
          autoComplete="off"
          disabled={busy || disabled}
          aria-describedby={recoveryInputId + '-hint'}
          onChange={(e) => setRecoveryInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void recoverContext(recoveryInput);
            }
          }}
        />
        <p id={recoveryInputId + '-hint'}>
          Read an existing unsigned review from this plan approval. This never
          creates a quote or renews approval.
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={busy || disabled || !recoveryInput.trim()}
          onClick={() => void recoverContext(recoveryInput)}
        >
          Read saved preparation context
        </Button>
      </details>
      {(marker || unreadableId) && (
        <details>
          <summary>Preparation recovery details</summary>
          <p>
            Request: <code>{marker?.id ?? unreadableId}</code>
            {!marker && ' (unverified local ID, display only)'}
          </p>
          {recoveryId && (
            <p>
              Earlier preparation: <code>{recoveryId}</code>
            </p>
          )}
          {marker?.priorRequestId && (
            <p>
              Previous local request (not confirmed):{' '}
              <code>{marker.priorRequestId}</code>. Recovering this saved review
              does not cancel another request.
            </p>
          )}
          <p>
            Original review version {marker?.journal.version ?? 'unavailable'}.
            Keep this browser reminder. A recovery read never renews the review
            or sends a transaction.
          </p>
          {result && (
            <p>
              Token mint: <code>{result.mint}</code>
            </p>
          )}
          {result?.simulation.inputAmountMatches === null && (
            <p>
              Native SOL input has no SPL-token amount comparison. This unsigned
              review is not a signing clearance.
            </p>
          )}
        </details>
      )}
    </section>
  );
}
