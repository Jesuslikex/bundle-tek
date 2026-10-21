'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import styles from './wallet-warmup-session-v2.module.css';
import type {
  WarmupV2Journal,
  WarmupV2Saved,
} from '@/lib/wallet-warmup-session-v2-view';
import {
  warmupV2AttemptReminder,
  warmupV2AttemptView,
  recoverWarmupV2AttemptView,
  warmupV2AttemptPage,
  type WarmupV2AttemptPage,
  type WarmupV2AttemptReminder,
  type WarmupV2AttemptView,
} from '@/lib/wallet-warmup-session-v2-attempt-view';
import { readWarmupConsentResponse } from '@/lib/wallet-warmup-session-consent-view';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
const endpoint = '/api/wallet-workspace/warmup/session-v2-attempts';
type Props = {
  journal: WarmupV2Journal;
  consent: WarmupV2Saved;
  disabled: boolean;
  invalidated?: boolean;
  now: number;
};
export function WalletWarmupSessionV2Attempt({
  journal,
  consent,
  disabled,
  invalidated = false,
  now,
}: Props) {
  const key = 'bundle:warmup-attempt-v2:' + journal.id,
    archivePrefix = key + ':saved:',
    loadIdentity = JSON.stringify([key, consent.id, consent.termsSha256]),
    context = JSON.stringify([
      journal.id,
      journal.version,
      journal.headSha256,
      consent.termsSha256,
      consent.id,
      invalidated,
    ]),
    scope = useRef(context),
    blocked = useRef(disabled || invalidated),
    active = useRef<AbortController | null>(null),
    mounted = useRef(false),
    rawMarker = useRef<string | null>(null),
    heading = useRef<HTMLHeadingElement | null>(null);
  const [marker, setMarker] = useState<WarmupV2AttemptReminder | null>(null),
    [saved, setSaved] = useState<WarmupV2AttemptView | null>(null),
    [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [invalid, setInvalid] = useState(false),
    [archives, setArchives] = useState<string[]>([]),
    [missing, setMissing] = useState(false),
    [repeatChecked, setRepeatChecked] = useState(false),
    [hint, setHint] = useState(''),
    [loadedFor, setLoadedFor] = useState(''),
    [page, setPage] = useState<WarmupV2AttemptPage | null>(null),
    [newestDiscoveredId, setNewestDiscoveredId] = useState(''),
    [archivePage, setArchivePage] = useState(0);
  useEffect(() => {
    mounted.current = true;
    let live = true;
    void (async () => {
      try {
        const raw = sessionStorage.getItem(key);
        rawMarker.current = raw;
        if (raw) {
          const original = await warmupV2AttemptReminder(
            JSON.parse(raw),
            consent,
          );
          if (live) setMarker(original);
        }
        if (live)
          setArchives(
            Object.keys(sessionStorage).filter((k) =>
              k.startsWith(archivePrefix),
            ),
          );
      } catch {
        if (live) {
          setInvalid(true);
          setError(
            'The original attempt reminder is unreadable. Keep it and recover the saved session before requesting another preview.',
          );
        }
      } finally {
        if (live) setLoadedFor(loadIdentity);
      }
    })();
    return () => {
      live = false;
      mounted.current = false;
      active.current?.abort();
      active.current = null;
    };
  }, [key, archivePrefix, consent, loadIdentity]);
  useLayoutEffect(() => {
    blocked.current = disabled || invalidated;
  }, [disabled, invalidated]);
  useLayoutEffect(() => {
    scope.current = context;
    active.current?.abort();
    active.current = null;
    let live = true;
    queueMicrotask(() => {
      if (live && mounted.current) {
        setBusy(false);
        setChecked(false);
        setRepeatChecked(false);
        setMissing(false);
        setSaved(null);
      }
    });
    return () => {
      live = false;
      active.current?.abort();
      active.current = null;
    };
  }, [context]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (
        event.storageArea !== sessionStorage ||
        (event.key !== key && event.key !== null)
      )
        return;
      active.current?.abort();
      active.current = null;
      setBusy(false);
      setChecked(false);
      setInvalid(true);
      setError(
        'The attempt reminder changed in another view. Recover the original IDs before new work.',
      );
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [key]);
  async function request(
    original: WarmupV2AttemptReminder | string,
    method: 'GET' | 'POST',
  ) {
    if (active.current || (invalid && method === 'POST')) return;
    if (method === 'POST' && (blocked.current || loadedFor !== loadIdentity))
      return;
    if (typeof original === 'string' && method !== 'GET') return;
    const originalId = typeof original === 'string' ? original : original.id;
    const token = context,
      controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setChecked(false);
    setRepeatChecked(false);
    setError('');
    setNotice('');
    setMissing(false);
    try {
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(40000),
      ]);
      const response = await fetch(
        method === 'GET'
          ? endpoint + '?id=' + encodeURIComponent(originalId)
          : endpoint,
        {
          method,
          signal,
          cache: 'no-store',
          ...(method === 'POST' && typeof original !== 'string'
            ? {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  id: original.id,
                  journalId: original.journal.id,
                  version: original.journal.version,
                  headSha256: original.journal.headSha256,
                  previewRequested: true,
                }),
              }
            : {}),
        },
      );
      const value = await readWarmupConsentResponse(response, signal);
      signal.throwIfAborted();
      if (!response.ok) {
        if (mounted.current && scope.current === token) {
          if (
            method === 'GET' &&
            response.status === 404 &&
            originalId === marker?.id
          )
            setMissing(true);
          const recoveryId = (value as { recoveryId?: unknown })?.recoveryId;
          if (
            typeof recoveryId === 'string' &&
            /^[a-f0-9-]{36}$/.test(recoveryId)
          )
            setHint(recoveryId);
        }
        throw Error(
          'The unsigned request was not confirmed. Keep its original ID and recover it before trying another request.',
        );
      }
      const recovered =
        typeof original === 'string'
          ? await recoverWarmupV2AttemptView(value, original, consent)
          : null;
      const admitted = recovered
        ? recovered.attempt
        : await warmupV2AttemptView(
            value,
            original as WarmupV2AttemptReminder,
            consent,
          );
      if (
        !mounted.current ||
        scope.current !== token ||
        controller.signal.aborted
      )
        return;
      if (recovered) {
        try {
          const text = JSON.stringify(recovered.marker),
            current = sessionStorage.getItem(key);
          if (
            current === null &&
            rawMarker.current === null &&
            !invalid &&
            newestDiscoveredId === recovered.marker.id
          ) {
            sessionStorage.setItem(key, text);
            if (sessionStorage.getItem(key) !== text) throw Error();
            rawMarker.current = text;
            setMarker(recovered.marker);
          } else if (marker?.id !== recovered.marker.id) {
            const archiveKey = archivePrefix + recovered.marker.id;
            if (sessionStorage.getItem(archiveKey) === null) {
              sessionStorage.setItem(archiveKey, text);
              if (sessionStorage.getItem(archiveKey) !== text) throw Error();
            }
            setArchives((prior) => [...new Set([...prior, archiveKey])]);
          }
        } catch {
          setInvalid(true);
          setError(
            'Saved request was read, but its reminder could not be kept locally. Keep the original ID; new requests remain disabled.',
          );
        }
      }
      setSaved(admitted);
      setNotice(
        method === 'GET'
          ? 'Saved-only recovery complete. No provider request or deadline renewal.'
          : 'Unsigned request recorded. No signing or trade was enabled.',
      );
      queueMicrotask(() => {
        if (mounted.current && scope.current === token)
          heading.current?.focus();
      });
    } catch {
      if (mounted.current && scope.current === token)
        setError(
          'No confirmed new result. Keep request ' +
            originalId +
            ' and use Recover unsigned request. No retry starts automatically.',
        );
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }
  async function loadHistory(before: number | null) {
    if (active.current) return;
    const token = context,
      controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    setChecked(false);
    try {
      const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(25000),
        ]),
        response = await fetch(
          endpoint +
            '?journalId=' +
            encodeURIComponent(journal.id) +
            (before === null ? '' : '&before=' + before),
          { signal, cache: 'no-store' },
        );
      const value = await readWarmupConsentResponse(response, signal);
      signal.throwIfAborted();
      if (!response.ok) throw Error();
      const next = warmupV2AttemptPage(value, journal, consent, before);
      if (mounted.current && scope.current === token) {
        setPage(next);
        if (before === null) setNewestDiscoveredId(next.requests[0]?.id ?? '');
        setNotice(
          'Saved request IDs loaded. No provider work or deadline renewal.',
        );
      }
    } catch {
      if (mounted.current && scope.current === token)
        setError(
          'Saved requests could not be read. Existing reminders are preserved.',
        );
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }
  const recoveredCurrent = !!marker && saved?.id === marker.id,
    previousFinished =
      recoveredCurrent &&
      !!saved &&
      (saved.outcome?.kind === 'refused' ||
        now >= Date.parse(saved.outcome?.expiresAt ?? saved.leaseExpiresAt)) &&
      now >= Date.parse(saved.nextAttemptAt),
    maxed = !!saved && recoveredCurrent && saved.attempt >= 3,
    eligible =
      loadedFor === loadIdentity &&
      !disabled &&
      !invalidated &&
      !invalid &&
      !busy &&
      journal.snapshot.phase === 'reviewing' &&
      !!journal.snapshot.pendingReview &&
      now < Date.parse(journal.sessionExpiresAt) &&
      ((!marker && !saved) || previousFinished) &&
      !maxed;
  async function start() {
    if (!eligible || !checked) return;
    try {
      if (
        typeof AbortSignal.any !== 'function' ||
        typeof AbortSignal.timeout !== 'function'
      )
        throw Error();
      if (sessionStorage.getItem(key) !== rawMarker.current) throw Error();
      const next = await warmupV2AttemptReminder(
        {
          format: 'wallet-warmup-attempt-reminder-v2',
          id: crypto.randomUUID(),
          journal,
        },
        consent,
      );
      if (scope.current !== context || blocked.current || active.current)
        return;
      if (marker && rawMarker.current) {
        const archiveKey = archivePrefix + marker.id;
        sessionStorage.setItem(archiveKey, rawMarker.current);
        if (sessionStorage.getItem(archiveKey) !== rawMarker.current)
          throw Error();
        setArchives((previous) => [...new Set([...previous, archiveKey])]);
      }
      const text = JSON.stringify(next);
      sessionStorage.setItem(key, text);
      if (sessionStorage.getItem(key) !== text) throw Error();
      rawMarker.current = text;
      setMarker(next);
      setSaved(null);
      await request(next, 'POST');
    } catch {
      setChecked(false);
      setError(
        'The original recovery IDs could not be safely retained. No new request was started.',
      );
    }
  }
  return (
    <section
      className={`${styles.card} ${styles.attempt}`}
      aria-label="Fresh unsigned warmup preview"
    >
      <h6 ref={heading} tabIndex={-1}>
        Fresh quote and simulation
      </h6>
      <p>
        Preview the pending action using the original spending limits and finish
        time. Maximum three attempts, at least 30 seconds apart. No wallet is
        unlocked and no trade is sent.
      </p>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={checked}
          disabled={!eligible}
          onChange={(e) => setChecked(e.target.checked)}
        />
        <span>
          Request this exact unsigned quote and simulation, and retain the
          private unsigned packet for recovery.
        </span>
      </label>
      <Button disabled={!eligible || !checked} onClick={() => void start()}>
        {marker ? 'Request next unsigned attempt' : 'Request unsigned preview'}
      </Button>
      {!eligible && (
        <p>
          {busy
            ? 'Reading and recording this request. Pause and Stop remain available above.'
            : journal.snapshot.phase === 'stopped'
              ? 'Session review is stopped. Saved-only recovery remains available; no new preview or trade can start.'
              : invalidated || now >= Date.parse(journal.sessionExpiresAt)
                ? 'The original plan changed or finished. Recover its history; this session cannot request new previews.'
                : maxed
                  ? 'All three attempts for this action are used. Recover history before reviewing a new plan.'
                  : marker && !previousFinished
                    ? 'Recover the original request first. A pending or unexpired request and its cooldown cannot be replaced.'
                    : 'Begin the pending review first. Paused, stopped, changed or finished sessions cannot request new previews.'}
        </p>
      )}
      {marker && (
        <div className={styles.field}>
          <p>
            Original request ID: <code>{marker.id}</code>
          </p>
          <Button
            variant="outline"
            disabled={busy || invalid}
            onClick={() => void request(marker, 'GET')}
          >
            Recover unsigned request
          </Button>
        </div>
      )}
      {marker && missing && (
        <div className={styles.field}>
          <p>
            No saved lease was found in that read. This does not prove an
            earlier handler failed. Requesting the same ID again can start its
            first read only if no lease exists; it never reruns a retained
            lease.
          </p>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={repeatChecked}
              disabled={busy || disabled || invalid}
              onChange={(e) => setRepeatChecked(e.target.checked)}
            />
            <span>Request the same original ID and exact head again.</span>
          </label>
          <Button
            variant="outline"
            disabled={
              busy ||
              disabled ||
              invalid ||
              !repeatChecked ||
              journal.version !== marker.journal.version ||
              journal.headSha256 !== marker.journal.headSha256 ||
              now >= Date.parse(journal.sessionExpiresAt)
            }
            onClick={() => void request(marker, 'POST')}
          >
            Request original ID again
          </Button>
        </div>
      )}
      {hint && (
        <div className={styles.field}>
          <p>
            An earlier pending request is available: <code>{hint}</code>.
            Reading it preserves the current reminder.
          </p>
          <Button
            variant="outline"
            disabled={busy || invalid}
            onClick={() => void request(hint, 'GET')}
          >
            Read earlier pending request
          </Button>
        </div>
      )}
      {saved && (
        <div className={styles.field}>
          <p>
            Attempt {saved.attempt} of 3 ·{' '}
            {saved.outcome?.kind ?? 'Result not confirmed'}.
          </p>
          <p>
            Original lease ends{' '}
            {new Date(saved.leaseExpiresAt).toLocaleString()}. Earliest next
            attempt {new Date(saved.nextAttemptAt).toLocaleString()}.
          </p>
          {saved.outcome?.kind === 'refused' && (
            <p>
              {saved.outcome.refusalCode === 'provider-limited'
                ? 'Provider rate limit refused this attempt. Wait for the original cooldown.'
                : saved.outcome.refusalCode === 'provider-unavailable'
                  ? 'The quote or simulation service was unavailable. This attempt is retained; its original limits still apply.'
                  : 'Fresh evidence was refused. This attempt is retained; it did not authorize a trade.'}
            </p>
          )}
          {saved.preview && (
            <>
              <p>
                Exact input:{' '}
                {saved.preview.side === 'Buy' ? (
                  <>{formatNativeBalance(saved.preview.inAmountRaw, 9)} SOL</>
                ) : (
                  <>
                    <code>{saved.preview.inAmountRaw}</code> base units
                  </>
                )}
                . Expected output: <code>{saved.preview.quotedOutRaw}</code>;
                minimum: <code>{saved.preview.minimumOutRaw}</code> base units.
              </p>
              <p>
                Provisional fee and rent cap:{' '}
                {formatNativeBalance(saved.preview.feeUpperBoundLamports, 9)}{' '}
                SOL. Preview expires{' '}
                {new Date(saved.outcome!.expiresAt).toLocaleString()}.
              </p>
              <p>
                Private packet retained. Simulation is not full instruction,
                custody or signing clearance.
              </p>
            </>
          )}
        </div>
      )}
      <details>
        <summary>Recover requests from another browser</summary>
        <p>
          Find this session’s saved request IDs without starting another
          preview.
        </p>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void loadHistory(null)}
        >
          Find saved requests
        </Button>
        {page && (
          <div className={styles.field}>
            {page.requests.length === 0 ? (
              <p>
                No saved requests were found in this read. An in-flight handler
                may still retain one.
              </p>
            ) : (
              page.requests.map((row) => (
                <div className={styles.field} key={row.id}>
                  <p>
                    Attempt {row.attempt} ·{' '}
                    {new Date(row.createdAt).toLocaleString()} ·{' '}
                    <code>{row.id}</code>
                  </p>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void request(row.id, 'GET')}
                  >
                    Recover saved attempt {row.attempt}
                  </Button>
                </div>
              ))
            )}
            {page.nextBefore !== null && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void loadHistory(page.nextBefore)}
              >
                Older saved requests
              </Button>
            )}
          </div>
        )}
      </details>
      {archives.length > 0 && (
        <details>
          <summary>
            Earlier retained request reminders ({archives.length})
          </summary>
          <p>
            These original IDs remain recoverable. Reading them does not replace
            the current request.
          </p>
          {archives
            .slice(archivePage * 10, archivePage * 10 + 10)
            .map((archiveKey) => (
              <Button
                variant="outline"
                key={archiveKey}
                disabled={busy || invalid}
                onClick={() => {
                  void (async () => {
                    try {
                      const raw = sessionStorage.getItem(archiveKey);
                      if (!raw) throw Error();
                      const original = await warmupV2AttemptReminder(
                        JSON.parse(raw),
                        consent,
                      );
                      await request(original, 'GET');
                    } catch {
                      setError(
                        'Earlier request reminder is unavailable. Keep its original ID.',
                      );
                    }
                  })();
                }}
              >
                Read earlier request {archiveKey.slice(archivePrefix.length)}
              </Button>
            ))}
          {archives.length > 10 && (
            <div className={styles.controls}>
              <Button
                variant="outline"
                disabled={busy || archivePage === 0}
                onClick={() => setArchivePage((p) => p - 1)}
              >
                Previous reminders
              </Button>
              <Button
                variant="outline"
                disabled={busy || (archivePage + 1) * 10 >= archives.length}
                onClick={() => setArchivePage((p) => p + 1)}
              >
                Next reminders
              </Button>
            </div>
          )}
        </details>
      )}
      {busy && (
        <output>
          Read-only provider work is in progress. No signature or transaction.
        </output>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <output>{notice}</output>}
    </section>
  );
}
