'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import styles from './wallet-warmup-session-v2.module.css';
import type {
  WarmupV2Journal,
  WarmupV2Saved,
} from '@/lib/wallet-warmup-session-v2-view';
import {
  warmupReadReminder as warmupV2AttemptReminder,
  warmupReadView as warmupV2AttemptView,
  recoverWarmupReadView as recoverWarmupV2AttemptView,
  warmupReadPage as warmupV2AttemptPage,
  warmupReadPostResponse,
  type WarmupReadPage as WarmupV2AttemptPage,
  type WarmupReadReminder as WarmupV2AttemptReminder,
  type WarmupReadView,
  type WarmupReadMode,
} from '@/lib/wallet-warmup-session-v2-read-view';
import { readWarmupConsentResponse } from '@/lib/wallet-warmup-session-consent-view';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import {
  isWarmupHistoryClockConflict,
  WARMUP_HISTORY_CLOCK_RECOVERY,
} from '@/lib/warmup-history-clock';
const endpoint = '/api/wallet-workspace/warmup/session-v2-attempts';
const runtimeEndpoint =
  '/api/wallet-workspace/warmup/session-v2-runtime-attempts';
const historyEndpoint = '/api/wallet-workspace/warmup/session-v2-read-history';
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
  const choiceVersion = useRef(0);
  const [marker, setMarker] = useState<WarmupV2AttemptReminder | null>(null),
    [readResult, setSaved] = useState<WarmupReadView | null>(null),
    [mode, setMode] = useState<WarmupReadMode>('preview'),
    [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [readingSaved, setReadingSaved] = useState(false),
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
    [discoveryContext, setDiscoveryContext] = useState(''),
    [archivePage, setArchivePage] = useState(0);
  const saved = readResult?.attempt ?? null;
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
          if (live) {
            setMarker(original);
            setMode(original.mode);
          }
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
        setPage(null);
        setNewestDiscoveredId('');
        setDiscoveryContext('');
        setHint('');
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
    expectedMode?: WarmupReadMode,
  ) {
    if (
      !mounted.current ||
      scope.current !== context ||
      loadedFor !== loadIdentity
    )
      return;
    if (active.current || (invalid && method === 'POST')) return;
    if (method === 'POST' && (blocked.current || loadedFor !== loadIdentity))
      return;
    if (typeof original === 'string' && method !== 'GET') return;
    const originalId = typeof original === 'string' ? original : original.id;
    const token = context,
      controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setReadingSaved(method === 'GET');
    setChecked(false);
    setRepeatChecked(false);
    setError('');
    setNotice('');
    setMissing(false);
    let clockAhead = false;
    try {
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(40000),
      ]);
      const response = await fetch(
        method === 'GET'
          ? historyEndpoint + '?id=' + encodeURIComponent(originalId)
          : typeof original !== 'string' && original.mode === 'runtime'
            ? runtimeEndpoint
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
                  [original.mode === 'runtime'
                    ? 'runtimeRequested'
                    : 'previewRequested']: true,
                }),
              }
            : {}),
        },
      );
      const value = await readWarmupConsentResponse(response, signal);
      signal.throwIfAborted();
      if (!response.ok) {
        clockAhead = isWarmupHistoryClockConflict(response.status, value);
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
            recoveryId !== originalId &&
            /^[a-f0-9-]{36}$/.test(recoveryId)
          )
            setHint(recoveryId);
        }
        throw Error(
          'The unsigned request was not confirmed. Keep its original ID and recover it before trying another request.',
        );
      }
      const displayValue =
        method === 'GET'
          ? value
          : warmupReadPostResponse(
              value,
              (original as WarmupV2AttemptReminder).mode,
            );
      const recovered =
        typeof original === 'string'
          ? await recoverWarmupV2AttemptView(displayValue, original, consent)
          : null;
      if (recovered && expectedMode && recovered.marker.mode !== expectedMode)
        throw Error('Saved mode changed.');
      const admitted = recovered
        ? recovered.view
        : await warmupV2AttemptView(
            displayValue,
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
            discoveryContext === token &&
            newestDiscoveredId === recovered.marker.id
          ) {
            sessionStorage.setItem(key, text);
            if (sessionStorage.getItem(key) !== text) throw Error();
            rawMarker.current = text;
            setMarker(recovered.marker);
            setMode(recovered.marker.mode);
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
      setHint('');
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
          clockAhead
            ? WARMUP_HISTORY_CLOCK_RECOVERY +
                ' Wait briefly, then use Recover unsigned request for ' +
                originalId +
                '.'
            : 'No confirmed new result. Keep request ' +
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
    if (
      !mounted.current ||
      scope.current !== context ||
      loadedFor !== loadIdentity ||
      active.current
    )
      return;
    const token = context,
      controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setReadingSaved(true);
    setError('');
    setNotice('');
    setChecked(false);
    let clockAhead = false;
    try {
      const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(25000),
        ]),
        response = await fetch(
          historyEndpoint +
            '?journalId=' +
            encodeURIComponent(journal.id) +
            (before === null ? '' : '&before=' + before),
          { signal, cache: 'no-store' },
        );
      const value = await readWarmupConsentResponse(response, signal);
      signal.throwIfAborted();
      if (!response.ok) {
        clockAhead = isWarmupHistoryClockConflict(response.status, value);
        throw Error();
      }
      const next = warmupV2AttemptPage(value, journal, consent, before);
      if (mounted.current && scope.current === token) {
        setPage(next);
        if (before === null) {
          setNewestDiscoveredId(next.requests[0]?.id ?? '');
          setDiscoveryContext(token);
        }
        setNotice(
          'Saved request IDs loaded. No provider work or deadline renewal.',
        );
      }
    } catch {
      if (mounted.current && scope.current === token)
        setError(
          clockAhead
            ? WARMUP_HISTORY_CLOCK_RECOVERY +
                ' Wait briefly, then use Find saved requests again.'
            : 'Saved requests could not be read. Existing reminders are preserved.',
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
  const nextAvailableAt = saved
    ? Math.max(
        Date.parse(saved.nextAttemptAt),
        Date.parse(saved.outcome?.expiresAt ?? saved.leaseExpiresAt),
      )
    : null;
  const disabledDescription = 'warmup-check-disabled-' + journal.id;
  async function start() {
    if (!eligible || !checked) return;
    const choice = choiceVersion.current;
    try {
      if (
        typeof AbortSignal.any !== 'function' ||
        typeof AbortSignal.timeout !== 'function'
      )
        throw Error();
      if (sessionStorage.getItem(key) !== rawMarker.current) throw Error();
      const next = await warmupV2AttemptReminder(
        {
          format: 'wallet-warmup-read-reminder-v1',
          mode,
          id: crypto.randomUUID(),
          journal,
        },
        consent,
      );
      if (
        !mounted.current ||
        scope.current !== context ||
        blocked.current ||
        active.current ||
        choiceVersion.current !== choice
      )
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
  function chooseMode(next: WarmupReadMode) {
    choiceVersion.current++;
    setMode(next);
    setChecked(false);
    setRepeatChecked(false);
  }
  return (
    <section
      className={`${styles.card} ${styles.attempt}`}
      aria-label="Fresh unsigned warmup checks"
    >
      <h6 ref={heading} tabIndex={-1}>
        Check the pending action
      </h6>
      <p>
        Preview the pending action using the original spending limits and finish
        time. Maximum three attempts, at least 30 seconds apart. No wallet is
        unlocked and no trade is sent.
      </p>
      <fieldset
        className={styles.modes}
        disabled={busy || (!!marker && !previousFinished)}
        aria-describedby={!eligible ? disabledDescription : undefined}
      >
        <legend>Choose a read-only check</legend>
        <label className={styles.check}>
          <input
            type="radio"
            name={'warmup-read-mode-' + journal.id}
            checked={mode === 'preview'}
            onChange={() => chooseMode('preview')}
          />
          <span>
            <strong>Quote and simulation</strong>
            <br />A basic unsigned preview of the exact pending action.
          </span>
        </label>
        <label className={styles.check}>
          <input
            type="radio"
            name={'warmup-read-mode-' + journal.id}
            checked={mode === 'runtime'}
            onChange={() => chooseMode('runtime')}
          />
          <span>
            <strong>Runtime checks</strong>
            <br />
            Also check account state and spending limits, and record program
            identity. No trading permission.
          </span>
        </label>
      </fieldset>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={checked}
          disabled={!eligible}
          aria-describedby={!eligible ? disabledDescription : undefined}
          onChange={(e) => {
            choiceVersion.current++;
            setChecked(e.target.checked);
          }}
        />
        <span>
          {mode === 'runtime'
            ? 'Request the exact runtime checks and retain their observations and private unsigned packet. This does not approve signing or a trade.'
            : 'Request this exact unsigned quote and simulation, and retain the private unsigned packet for recovery.'}
        </span>
      </label>
      <Button
        disabled={!eligible || !checked}
        aria-describedby={!eligible ? disabledDescription : undefined}
        onClick={() => void start()}
      >
        {mode === 'runtime'
          ? marker
            ? 'Request next runtime check'
            : 'Request runtime checks'
          : marker
            ? 'Request next unsigned attempt'
            : 'Request unsigned preview'}
      </Button>
      {!eligible && (
        <p id={disabledDescription}>
          {busy
            ? readingSaved
              ? 'Reading saved records. This does not start another provider check.'
              : 'Checking and recording this request. Keep its original request ID for recovery.'
            : journal.snapshot.phase === 'stopped'
              ? 'Session review is stopped. Saved-only recovery remains available; no new preview or trade can start.'
              : invalidated || now >= Date.parse(journal.sessionExpiresAt)
                ? 'The original plan changed or finished. Recover its history; this session cannot request new previews.'
                : maxed
                  ? 'All three attempts for this action are used. Recover history before reviewing a new plan.'
                  : invalid
                    ? 'The local recovery reminder needs attention. Recover this session before requesting another check.'
                    : disabled
                      ? 'A session history or control request is in progress. Wait for it before requesting another check.'
                      : recoveredCurrent && !previousFinished
                        ? 'This request is recovered. Its original expiry and shared cooldown must finish before another check. Recovering it again does not shorten that wait.'
                        : saved && !recoveredCurrent
                          ? 'This is an earlier saved result. Recover the current or newest request before another check.'
                          : marker && !previousFinished
                            ? 'Recover the original request first. A pending or unexpired request and its cooldown cannot be replaced.'
                            : 'Begin the pending review first. Paused, stopped, changed or finished sessions cannot request new previews.'}
        </p>
      )}
      {marker && (
        <div className={styles.field}>
          <p>
            Saved mode:{' '}
            {marker.mode === 'runtime'
              ? 'Runtime checks'
              : 'Quote and simulation'}
            . Original request ID: <code>{marker.id}</code>
          </p>
          <Button
            variant="outline"
            disabled={busy || invalid || loadedFor !== loadIdentity}
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
            disabled={busy || invalid || loadedFor !== loadIdentity}
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
            {saved.outcome?.kind === 'prepared'
              ? readResult?.mode === 'runtime'
                ? 'Runtime observations saved'
                : 'Unsigned preview saved'
              : saved.outcome?.kind === 'refused'
                ? 'Check refused'
                : 'Result not confirmed'}
            .
          </p>
          <p>
            Original lease ends{' '}
            {new Date(saved.leaseExpiresAt).toLocaleString()}.
            {recoveredCurrent ? (
              <>
                {' '}
                Next check no earlier than{' '}
                {new Date(nextAvailableAt!).toLocaleString()}.
              </>
            ) : (
              ' Historical result only. Recover the current request for its timing.'
            )}
          </p>
          {readResult?.runtime?.observation && (
            <p>
              Shared request expiry:{' '}
              {new Date(
                saved.outcome?.expiresAt ?? saved.leaseExpiresAt,
              ).toLocaleString()}
              . The runtime observation below can expire sooner.
            </p>
          )}
          {saved.outcome?.kind === 'refused' && (
            <p>
              {saved.outcome.refusalCode === 'provider-limited'
                ? 'Provider rate limit refused this attempt. Wait for the original cooldown.'
                : saved.outcome.refusalCode === 'provider-unavailable'
                  ? 'A required provider read was unavailable. This attempt is retained; its original limits still apply.'
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
                SOL.{' '}
                {readResult?.mode === 'runtime'
                  ? 'Runtime observations expire'
                  : 'Preview expires'}{' '}
                {new Date(
                  readResult?.runtime?.effectiveExpiresAt ??
                    saved.outcome!.expiresAt,
                ).toLocaleString()}
                .
              </p>
              <p>
                Private packet retained.{' '}
                {readResult?.mode === 'runtime'
                  ? 'Saved runtime observations do not grant signing or trading permission.'
                  : 'Simulation is not full instruction, custody or signing clearance.'}
              </p>
              {readResult?.runtime?.observation && (
                <div className={styles.runtime}>
                  <strong>
                    {now >= Date.parse(readResult.runtime.effectiveExpiresAt!)
                      ? 'Runtime checks expired. Saved history only.'
                      : 'Runtime observations saved. No trade approved.'}
                  </strong>
                  <p>
                    These observations do not check an independent price or
                    establish trusted program code.
                  </p>
                  <p>
                    A new request still waits for the original request expiry
                    and shared cooldown. Recovery never renews these
                    observations.
                  </p>
                  <details>
                    <summary>View check coverage</summary>
                    <p>
                      Account observations span{' '}
                      {readResult.runtime.observation.maximumSlot -
                        readResult.runtime.observation.minimumSlot}{' '}
                      of 32 slots. Both full code scans were observed for{' '}
                      {readResult.runtime.observation.programCount} programs.
                    </p>
                    <p>
                      Code chunks use context-slot floors, without a Clock read
                      for each chunk. These records cannot approve a signature
                      or trade.
                    </p>
                  </details>
                </div>
              )}
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
          disabled={busy || loadedFor !== loadIdentity}
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
                    {row.mode === 'runtime'
                      ? 'Runtime checks'
                      : 'Quote and simulation'}{' '}
                    · Attempt {row.attempt} ·{' '}
                    {new Date(row.createdAt).toLocaleString()} ·{' '}
                    <code>{row.id}</code>
                  </p>
                  <Button
                    variant="outline"
                    disabled={busy || loadedFor !== loadIdentity}
                    onClick={() => void request(row.id, 'GET', row.mode)}
                  >
                    Recover saved attempt {row.attempt}
                  </Button>
                </div>
              ))
            )}
            {page.nextBefore !== null && (
              <Button
                variant="outline"
                disabled={busy || loadedFor !== loadIdentity}
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
                disabled={busy || invalid || loadedFor !== loadIdentity}
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
          {readingSaved
            ? 'Reading saved records. No provider request or deadline renewal.'
            : 'Read-only provider checks are in progress. No signature or transaction.'}
        </output>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <output>{notice}</output>}
    </section>
  );
}
