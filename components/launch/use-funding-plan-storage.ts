'use client';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';
import type { SavedFunding } from '@/lib/funding-plan';
import { readBoundedPanelJson } from '@/lib/read-bounded-panel-json';
import {
  decodeFundingList,
  decodeSavedFunding,
  fundingResponse,
  fundingWriteResponse,
  FundingMutationRejected,
  type FundingMutation,
} from '@/lib/funding-plan-storage';
import {
  createFundingSaveReminder,
  readFundingSaveMutation,
  readFundingSaveReminder,
  fundingReminderOutcome,
} from '@/lib/funding-save-reminder';
import {
  readFundingSaveStopRequest,
  readFundingSaveStopReceipt,
} from '@/lib/funding-save-stop';

type Reminder = Awaited<ReturnType<typeof createFundingSaveReminder>>;
type StopRequest = ReturnType<typeof readFundingSaveStopRequest>;
type StopReceipt = Awaited<ReturnType<typeof readFundingSaveStopReceipt>>;
type Phase = 'load' | 'save' | 'recover' | 'stop' | 'recover-stop';
type RequestState = {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  phase: Phase;
};
export const FUNDING_REQUEST_TIMEOUT_MS = 30_000;
const scopeHeader = 'x-bundle-funding-owner-scope';
const scopePattern = /^[a-f0-9]{64}$/;
const storageKey = (scope: string) => `bundle-funding-save:${scope}`;
const stopStorageKey = (scope: string) => `bundle-funding-save-stop:${scope}`;
const unknownStop =
  'The draft-save stop needs checking. Its original ID is retained. No transfer was cancelled; do not repeat the original save.';
const unknownSave =
  'Save outcome unknown. The server may have saved it. Check the original draft before continuing; no funds were moved.';
const storageFailure =
  'Funding save recovery storage is unavailable or invalid. No new save can be sent. Keep the original recovery record and check its saved result.';
const scopeFailure =
  'Account changed or could not be verified. Reload saved plans. Recovery for the original account is retained; no save was repeated.';
const locksFailure =
  'This browser cannot protect funding saves across tabs. Use an up-to-date browser on the secure app URL. Saved history and original-save recovery remain available.';
function responseScope(response: Response) {
  const value = response.headers?.get(scopeHeader) ?? null;
  return value !== null && scopePattern.test(value) ? value : null;
}
function lockManager(): LockManager | null {
  try {
    return typeof navigator !== 'undefined' &&
      typeof navigator.locks?.request === 'function'
      ? navigator.locks
      : null;
  } catch {
    return null;
  }
}
function readStored(scope: string) {
  const text = localStorage.getItem(storageKey(scope));
  if (text === null) return null;
  const reminder = readFundingSaveReminder(JSON.parse(text));
  if (reminder.ownerScope !== scope) throw Error(storageFailure);
  return { reminder, text };
}
function readStoredStop(scope: string) {
  const text = localStorage.getItem(stopStorageKey(scope));
  if (text === null) return null;
  if (text.length > 2048) throw Error(storageFailure);
  const request = readFundingSaveStopRequest(JSON.parse(text));
  if (request.reminder.ownerScope !== scope) throw Error(storageFailure);
  return { request, text };
}
function sameReminder(a: Reminder, b: Reminder) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Release local locks when waiting stops, even if a transport ignores abort.
 * A dispatched write remains represented by its durable reminder. */
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/** Persist only lookup coordinates and a document hash, never the funding draft.
 * A retained record cannot resume or authorize a financial operation. */
export function useFundingPlanStorage(
  onCommitted: (attempt: FundingMutation, revision: number) => void,
  onScopeChanged?: () => void,
  onFenced?: (id: string, expectedRevision: number) => void,
) {
  const [plans, setPlans] = useState<SavedFunding[]>([]);
  const [phase, setPhase] = useState<Phase | null>('load');
  const [pending, setPending] = useState<Reminder | null>(null);
  const [pendingStop, setPendingStop] = useState<StopRequest | null>(null);
  const stopRecord = useRef<{ request: StopRequest; text: string } | null>(
    null,
  );
  const [ownerScope, setOwnerScope] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const active = useRef<RequestState | null>(null);
  const scope = useRef<string | null>(null);
  const writeReady = useRef(false);
  const reminder = useRef<Reminder | null>(null);
  const recordText = useRef<string | null>(null);
  // Only the original mounted editor can retry its immutable request body.
  const retained = useRef<FundingMutation | null>(null);
  const [hasOriginalPayload, setHasOriginalPayload] = useState(false);
  const retainPayload = useCallback((value: FundingMutation | null) => {
    retained.current = value;
    setHasOriginalPayload(value !== null);
  }, []);
  const committed = useRef(onCommitted),
    changed = useRef(onScopeChanged),
    fenced = useRef(onFenced);
  useEffect(() => {
    committed.current = onCommitted;
    changed.current = onScopeChanged;
    fenced.current = onFenced;
  }, [onCommitted, onScopeChanged, onFenced]);
  const retainStop = useCallback(
    (value: { request: StopRequest; text: string } | null) => {
      stopRecord.current = value;
      setPendingStop(value?.request ?? null);
    },
    [],
  );
  const setReadyState = useCallback((value: boolean) => {
    writeReady.current = value;
    setReady(value);
  }, []);
  const retain = useCallback(
    (value: Reminder | null, text: string | null) => {
      reminder.current = value;
      recordText.current = text;
      setPending(value);
      if (value === null) retainPayload(null);
    },
    [retainPayload],
  );
  const cancel = useCallback((timedOut = false) => {
    const request = active.current;
    if (!request) return;
    active.current = null;
    clearTimeout(request.timer);
    request.controller.abort();
    setPhase(null);
    setError(
      stopRecord.current
        ? unknownStop
        : reminder.current
          ? request.phase === 'save'
            ? unknownSave
            : 'Checking stopped. The original save still needs checking; no new save was sent.'
          : timedOut
            ? 'The funding request timed out before a save could be confirmed. Reload saved plans or check the original draft.'
            : 'Request cancelled. Your editable draft is preserved.',
    );
  }, []);
  const begin = useCallback(
    (next: Phase) => {
      if (!mounted.current || active.current) return null;
      const request: RequestState = {
        phase: next,
        controller: new AbortController(),
        timer: setTimeout(() => cancel(true), FUNDING_REQUEST_TIMEOUT_MS),
      };
      active.current = request;
      setPhase(next);
      setError('');
      setNotice('');
      return request;
    },
    [cancel],
  );
  const finish = useCallback((request: RequestState) => {
    clearTimeout(request.timer);
    if (active.current === request) {
      active.current = null;
      setPhase(null);
    }
  }, []);
  const current = (request: RequestState) =>
    mounted.current &&
    active.current === request &&
    !request.controller.signal.aborted;

  const load = async () => {
    const request = begin('load');
    if (!request) return;
    setReadyState(false);
    try {
      // Deliberately do not send a previous owner scope: this read discovers
      // the currently authenticated account after a sign-in/account change.
      const response = await untilAbort(
        fetch('/api/funding', {
          cache: 'no-store',
          signal: request.controller.signal,
        }),
        request.controller.signal,
      );
      if (!current(request)) return;
      if (response.status === 401) {
        setPlans([]);
        throw Error('Sign in again to open or recover funding drafts.');
      }
      const nextScope = responseScope(response);
      const rows = decodeFundingList(
        await untilAbort(fundingResponse(response), request.controller.signal),
      );
      if (!current(request)) return;
      setPlans(rows);
      if (!nextScope) {
        setError(
          'Saved history loaded, but this server did not identify its account scope. New saves are disabled until the current server and account can be verified.',
        );
        return;
      }
      const newOwner = scope.current !== nextScope;
      if (newOwner) {
        if (scope.current !== null) {
          changed.current?.();
          setNotice(
            'Account changed. The previous editor and selection were cleared. Any remaining recovery reference stays with its original account.',
          );
        }
        retainPayload(null);
        retain(null, null);
        retainStop(null);
      }
      scope.current = nextScope;
      setOwnerScope(nextScope);
      try {
        const stored = readStored(nextScope);
        const storedStop = readStoredStop(nextScope);
        if (storedStop) {
          if (
            stored &&
            !sameReminder(stored.reminder, storedStop.request.reminder)
          )
            throw Error(storageFailure);
          retainPayload(null);
          retainStop(storedStop);
          retain(
            storedStop.request.reminder,
            stored?.text ?? JSON.stringify(storedStop.request.reminder),
          );
        }
        if (stored && reminder.current === null) {
          retainPayload(null);
          retain(stored.reminder, stored.text);
        }
        // A same-scope refresh cannot clear an unresolved request even if its
        // record was removed elsewhere. Only exact recovery can clear it.
        if (!lockManager()) {
          setReadyState(false);
          setError(locksFailure);
        } else setReadyState(true);
        if (stopRecord.current) setNotice(unknownStop);
        else if (reminder.current)
          setNotice(
            'An original funding save needs checking. No new funding change was sent.',
          );
      } catch {
        setReadyState(false);
        setError(storageFailure);
      }
    } catch (cause) {
      if (current(request))
        setError(
          cause instanceof Error
            ? cause.message
            : 'Funding drafts are unavailable.',
        );
    } finally {
      finish(request);
    }
  };
  const startLoading = useEffectEvent(() => {
    void load();
  });
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    queueMicrotask(() => {
      if (alive) startLoading();
    });
    return () => {
      alive = false;
      mounted.current = false;
      const request = active.current;
      active.current = null;
      if (request) {
        clearTimeout(request.timer);
        request.controller.abort();
      }
    };
  }, []);

  /** Must run while holding this owner's exclusive browser lock. */
  function clearExact(captured: Reminder, text: string) {
    if (readStoredStop(captured.ownerScope)) return false;
    const key = storageKey(captured.ownerScope);
    const value = localStorage.getItem(key);
    if (value !== null && value !== text) return false;
    if (value === text) localStorage.removeItem(key);
    if (localStorage.getItem(key) !== null) return false;
    return true;
  }
  function refuseChangedResponse(response: Response, capturedScope: string) {
    if (responseScope(response) === capturedScope) return false;
    setReadyState(false);
    setError(scopeFailure);
    return true;
  }
  /** A strict receipt fences a revision, not transfers or the save's historical outcome.
   * The caller must hold the same owner lock used by every save and stop. */
  function clearFenced(
    receipt: StopReceipt,
    original: Reminder,
    originalText: string,
    request: RequestState,
  ) {
    if (
      !current(request) ||
      scope.current !== original.ownerScope ||
      receipt.reminder.ownerScope !== original.ownerScope ||
      receipt.reminder.id !== original.id ||
      receipt.reminder.expectedRevision !== original.expectedRevision ||
      !reminder.current ||
      !sameReminder(reminder.current, original)
    )
      throw Error(unknownStop);
    const storedStop = readStoredStop(original.ownerScope);
    const capturedStop = stopRecord.current;
    if (
      (storedStop &&
        (!sameReminder(storedStop.request.reminder, original) ||
          (capturedStop && storedStop.text !== capturedStop.text))) ||
      (capturedStop && !sameReminder(capturedStop.request.reminder, original))
    )
      throw Error(storageFailure);
    const key = storageKey(original.ownerScope);
    const savedText = localStorage.getItem(key);
    if (savedText !== null && savedText !== originalText)
      throw Error(storageFailure);
    // Remove original first: the remaining stop marker carries its coordinates
    // if storage removal fails or this page disappears between the two removals.
    if (savedText !== null) localStorage.removeItem(key);
    if (localStorage.getItem(key) !== null) throw Error(storageFailure);
    const stopText = storedStop?.text ?? capturedStop?.text ?? null;
    const stopKey = stopStorageKey(original.ownerScope);
    if (
      localStorage.getItem(stopKey) !== stopText &&
      localStorage.getItem(stopKey) !== null
    )
      throw Error(storageFailure);
    if (localStorage.getItem(stopKey) !== null)
      localStorage.removeItem(stopKey);
    if (localStorage.getItem(stopKey) !== null) throw Error(storageFailure);
    retainStop(null);
    retain(null, null);
    setPlans((previous) => previous.filter((row) => row.id !== original.id));
    fenced.current?.(original.id, original.expectedRevision);
    setNotice(
      'The original expected draft revision can no longer write. This does not establish whether the original save succeeded. No transfers were cancelled. Your editor was preserved. ' +
        (receipt.outcome === 'creation_fenced'
          ? 'No original saved draft existed when the stop committed. You can start a new draft.'
          : 'Reload saved plans and explicitly open the current plan. Check earlier submitted transfers in funding history.'),
    );
  }
  const stopOriginal = async (
    mode: 'start' | 'retry' | 'recover',
    approved = false,
  ) => {
    const original = reminder.current;
    const originalText = recordText.current;
    const capturedScope = scope.current;
    if (
      !original ||
      originalText === null ||
      capturedScope !== original.ownerScope
    )
      return;
    if (!writeReady.current || (mode === 'start' && !approved)) {
      setError(
        'Verify this account and separately approve stopping this draft save.',
      );
      return;
    }
    const locks = lockManager();
    if (!locks) {
      setError(locksFailure);
      return;
    }
    const request = begin(mode === 'recover' ? 'recover-stop' : 'stop');
    if (!request) return;
    let dispatched = false;
    try {
      await locks.request(
        storageKey(capturedScope),
        { ifAvailable: true },
        async (lock) => {
          if (!lock || !current(request) || scope.current !== capturedScope) {
            if (current(request))
              setError(
                'Another tab is using funding recovery. No stop request was sent.',
              );
            return;
          }
          const stored = readStored(capturedScope);
          const savedStop = readStoredStop(capturedScope);
          if (
            (stored && stored.text !== originalText) ||
            (savedStop &&
              !sameReminder(savedStop.request.reminder, original)) ||
            (stopRecord.current &&
              savedStop &&
              stopRecord.current.text !== savedStop.text)
          )
            throw Error(storageFailure);
          if (mode === 'start' && (savedStop || stopRecord.current)) {
            if (savedStop) retainStop(savedStop);
            throw Error(
              'A stop request already exists. Check its original result or retry that same stop request.',
            );
          }
          let stop = savedStop ?? stopRecord.current;
          if (mode === 'start') {
            if (!stored || !sameReminder(stored.reminder, original))
              throw Error(storageFailure);
            const value = readFundingSaveStopRequest({
              format: 'funding-save-stop-request-v1',
              stopId: crypto.randomUUID(),
              reminder: original,
              consent: 'stop-draft-save-v1',
            });
            stop = { request: value, text: JSON.stringify(value) };
          }
          if (!stop || !sameReminder(stop.request.reminder, original))
            throw Error(unknownStop);
          // A retained in-memory retry is never allowed to overwrite another tab.
          if (!savedStop) {
            localStorage.setItem(stopStorageKey(capturedScope), stop.text);
            if (
              localStorage.getItem(stopStorageKey(capturedScope)) !== stop.text
            )
              throw Error(storageFailure);
          }
          retainStop(stop);
          retainPayload(null);
          if (!current(request) || scope.current !== capturedScope) return;
          dispatched = mode !== 'recover';
          const response = await untilAbort(
            fetch(
              '/api/funding/save-stops' +
                (mode === 'recover'
                  ? '?stopId=' + encodeURIComponent(stop.request.stopId)
                  : ''),
              {
                method: mode === 'recover' ? 'GET' : 'POST',
                cache: 'no-store',
                signal: request.controller.signal,
                headers: {
                  [scopeHeader]: capturedScope,
                  ...(mode === 'recover'
                    ? {}
                    : { 'content-type': 'application/json' }),
                },
                ...(mode === 'recover' ? {} : { body: stop.text }),
              },
            ),
            request.controller.signal,
          );
          if (
            !current(request) ||
            refuseChangedResponse(response, capturedScope)
          )
            return;
          if (response.status !== 200) {
            void response.body?.cancel().catch(() => {});
            throw Error(
              response.status === 404
                ? 'The original stop receipt is not visible yet. Both recovery references are kept. Check it again or retry the same stop request.'
                : unknownStop,
            );
          }
          const body = await untilAbort(
            readBoundedPanelJson(response, request.controller.signal),
            request.controller.signal,
          );
          if (
            !body ||
            typeof body !== 'object' ||
            Array.isArray(body) ||
            Object.keys(body).join(',') !== 'receipt'
          )
            throw Error(unknownStop);
          const receipt = await untilAbort(
            readFundingSaveStopReceipt(
              (body as { receipt: unknown }).receipt,
              stop.request,
            ),
            request.controller.signal,
          );
          if (!current(request)) return;
          clearFenced(receipt, original, originalText, request);
        },
      );
    } catch {
      if (current(request))
        setError(
          dispatched || stopRecord.current ? unknownStop : storageFailure,
        );
    } finally {
      finish(request);
    }
  };
  const save = async (attempt: FundingMutation) => {
    if (stopRecord.current) {
      setError(unknownStop);
      return;
    }
    if (!writeReady.current || scope.current === null) {
      setError(
        'Load current saved plans and verify recovery storage before saving.',
      );
      return;
    }
    if (reminder.current && retained.current !== attempt) {
      setError(unknownSave);
      return;
    }
    const locks = lockManager();
    if (!locks) {
      setReadyState(false);
      setError(locksFailure);
      return;
    }
    const request = begin('save');
    if (!request) return;
    const capturedScope = scope.current;
    const retryingUnknown = reminder.current !== null;
    let captured: FundingMutation;
    let capturedReminder: Reminder | null = null;
    let serialized: string | null = null;
    let dispatched = false;
    try {
      captured = readFundingSaveMutation(attempt);
      capturedReminder = await untilAbort(
        createFundingSaveReminder(capturedScope, captured),
        request.controller.signal,
      );
      serialized = JSON.stringify(capturedReminder);
      if (!current(request) || scope.current !== capturedScope) return;
      await locks.request(
        storageKey(capturedScope),
        { ifAvailable: true },
        async (lock) => {
          if (!current(request) || scope.current !== capturedScope) return;
          if (!lock) {
            setError(
              'Another tab is checking or saving funding for this account. No save was sent. Check the original save before trying again.',
            );
            return;
          }
          const original = capturedReminder!;
          const text = serialized!;
          try {
            const stopping = readStoredStop(capturedScope);
            if (stopping) {
              retainStop(stopping);
              retainPayload(null);
              const prior = readStored(capturedScope);
              if (
                prior &&
                !sameReminder(prior.reminder, stopping.request.reminder)
              )
                throw Error(storageFailure);
              retain(
                stopping.request.reminder,
                prior?.text ?? JSON.stringify(stopping.request.reminder),
              );
              setError(unknownStop);
              return;
            }
            const stored = readStored(capturedScope);
            if (
              stored &&
              (!retryingUnknown || JSON.stringify(stored.reminder) !== text)
            ) {
              retainPayload(null);
              retain(stored.reminder, stored.text);
              setError(unknownSave);
              return;
            }
            if (
              retryingUnknown &&
              reminder.current &&
              JSON.stringify(reminder.current) !== text
            ) {
              setError(unknownSave);
              return;
            }
            if (!stored) {
              localStorage.setItem(storageKey(capturedScope), text);
              if (localStorage.getItem(storageKey(capturedScope)) !== text)
                throw Error();
            }
            retainPayload(captured);
            retain(original, stored?.text ?? text);
            serialized = stored?.text ?? text;
          } catch {
            setReadyState(false);
            setError(storageFailure);
            return;
          }
          if (!current(request) || scope.current !== capturedScope) return;
          dispatched = true;
          const response = await untilAbort(
            fetch('/api/funding', {
              method: 'POST',
              signal: request.controller.signal,
              headers: {
                'content-type': 'application/json',
                [scopeHeader]: capturedScope,
              },
              body: JSON.stringify({
                ...captured,
                document:
                  captured.action === 'save' ? captured.document : undefined,
              }),
            }),
            request.controller.signal,
          );
          if (!current(request)) return;
          const replyScope = responseScope(response);
          if (
            !retryingUnknown &&
            response.status === 403 &&
            replyScope &&
            replyScope !== capturedScope
          ) {
            // This exact first POST was refused before any SQL. This proof
            // cannot clear an earlier attempt whose outcome was already unknown.
            const rejection = (await untilAbort(
              readBoundedPanelJson(response, request.controller.signal),
              request.controller.signal,
            ).catch(() => null)) as Record<string, unknown> | null;
            if (
              current(request) &&
              rejection &&
              Object.keys(rejection).sort().join(',') ===
                'code,error,rejectedScope' &&
              rejection.code === 'FUNDING_SCOPE_REJECTED_BEFORE_WRITE' &&
              rejection.rejectedScope === capturedScope &&
              typeof rejection.error === 'string'
            ) {
              if (clearExact(original, serialized!)) retain(null, null);
              setReadyState(false);
              setError(
                'The signed-in account changed before this save. No funding draft was written. Reload saved plans to use the current account.',
              );
              return;
            }
          }
          if (refuseChangedResponse(response, capturedScope)) return;
          if (response.ok && response.status !== 200) {
            void response.body?.cancel().catch(() => {});
            throw Error(
              'The response did not confirm a committed funding save.',
            );
          }
          let result: Awaited<ReturnType<typeof fundingWriteResponse>>;
          try {
            result = await untilAbort(
              fundingWriteResponse(response),
              request.controller.signal,
            );
          } catch (cause) {
            if (
              cause instanceof FundingMutationRejected &&
              !retryingUnknown &&
              current(request)
            ) {
              // Clear a definitive first rejection only inside the same owner
              // lock, after matching its authenticated response scope.
              if (clearExact(original, serialized!)) {
                retain(null, null);
                if (cause.status === 409)
                  setPlans((previous) =>
                    previous.filter((row) => row.id !== original.id),
                  );
                setError(cause.message);
              } else {
                retainPayload(null);
                setReadyState(false);
                setError(storageFailure);
              }
              return;
            }
            throw cause;
          }
          if (
            result.id !== captured.id ||
            result.revision !== captured.expectedRevision + 1
          )
            throw Error(
              'The save acknowledgement did not match the original draft.',
            );
          if (!current(request) || scope.current !== capturedScope) return;
          let cleared = false;
          try {
            cleared = clearExact(original, serialized!);
          } catch {
            setReadyState(false);
            setError(storageFailure);
            return;
          }
          if (!cleared) {
            retainPayload(null);
            setReadyState(false);
            setError(
              'The original save was acknowledged, but its local recovery record changed in another tab. It has not been erased. Reload saved plans and inspect the original result.',
            );
            return;
          }
          retain(null, null);
          committed.current(captured, Number(result.revision));
          finish(request);
          void load();
          setNotice(
            captured.action === 'save'
              ? 'Funding draft saved. No funds moved.'
              : captured.action === 'archive'
                ? 'Funding draft archived.'
                : 'Funding draft restored.',
          );
        },
      );
    } catch {
      if (current(request)) {
        setError(
          dispatched
            ? unknownSave
            : 'The funding request could not be retained or prepared. No new save was dispatched. Reload saved plans before trying again.',
        );
      }
    } finally {
      finish(request);
    }
  };
  const recover = async () => {
    const original = reminder.current;
    const originalText = recordText.current;
    const capturedScope = scope.current;
    if (
      !original ||
      originalText === null ||
      capturedScope === null ||
      original.ownerScope !== capturedScope
    )
      return;
    try {
      const stopping = readStoredStop(capturedScope);
      if (stopping) {
        if (!sameReminder(stopping.request.reminder, original))
          throw Error(storageFailure);
        retainStop(stopping);
        retainPayload(null);
      }
    } catch {
      setReadyState(false);
      setError(storageFailure);
      return;
    }
    const request = begin('recover');
    if (!request) return;
    const originalPayload = retained.current;
    try {
      const response = await untilAbort(
        fetch(
          '/api/funding?id=' +
            encodeURIComponent(original.id) +
            '&expectedRevision=' +
            original.expectedRevision,
          {
            cache: 'no-store',
            signal: request.controller.signal,
            headers: { [scopeHeader]: capturedScope },
          },
        ),
        request.controller.signal,
      );
      if (!current(request)) return;
      // A missing row cannot prove a potentially delayed original write is done.
      // Its error response may omit the scope; only successful recovery admits it.
      if (response.status === 404)
        throw Error(
          'The original draft is not visible yet. Its save may still finish. Check again; do not create a different replacement save.',
        );
      if (refuseChangedResponse(response, capturedScope)) return;
      if (response.status === 409) {
        const body = await untilAbort(
          readBoundedPanelJson(response, request.controller.signal),
          request.controller.signal,
        );
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).sort().join(',') !== 'code,error,receipt' ||
          (body as Record<string, unknown>).code !== 'FUNDING_SAVE_STOPPED' ||
          typeof (body as Record<string, unknown>).error !== 'string'
        )
          throw Error(unknownStop);
        const receipt = await untilAbort(
          readFundingSaveStopReceipt((body as { receipt: unknown }).receipt),
          request.controller.signal,
        );
        const locks = lockManager();
        if (!locks) throw Error(locksFailure);
        let cleared = false;
        await locks.request(
          storageKey(capturedScope),
          { ifAvailable: true },
          (lock) => {
            if (!lock || !current(request)) return;
            clearFenced(receipt, original, originalText, request);
            cleared = true;
          },
        );
        if (!cleared)
          throw Error(
            'Another tab is using recovery. The original reference was kept.',
          );
        return;
      }
      // A competing stop ID may have won the unique revision fence while our
      // own stop ID remains absent. Only a strict fence receipt can resolve that
      // combined operation; an ordinary saved document cannot clear it.
      if (stopRecord.current || readStoredStop(capturedScope))
        throw Error(unknownStop);
      if (response.ok && response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        throw Error('The response did not confirm a saved funding result.');
      }
      const body = await untilAbort(
        fundingResponse(response),
        request.controller.signal,
      );
      const row = decodeSavedFunding(body.plan);
      const outcome = await fundingReminderOutcome(original, row);
      if (!current(request) || scope.current !== capturedScope) return;
      if (outcome === 'unknown')
        throw Error(
          'The saved revision has not advanced yet. Its save may still finish. Check the original request again.',
        );
      setPlans((previous) =>
        [row, ...previous.filter((value) => value.id !== row.id)].slice(0, 100),
      );
      const locks = lockManager();
      if (!locks) {
        setReadyState(false);
        setNotice(
          'The original saved result is visible. Browser protection is unavailable, so its local recovery record was kept. No save was repeated.',
        );
        setError(locksFailure);
        return;
      }
      let cleared = false;
      await locks.request(
        storageKey(capturedScope),
        { ifAvailable: true },
        (lock) => {
          if (!lock || !current(request) || scope.current !== capturedScope)
            return;
          try {
            cleared = clearExact(original, originalText);
          } catch {
            setReadyState(false);
            setError(storageFailure);
          }
        },
      );
      if (!current(request)) return;
      if (!cleared) {
        retainPayload(null);
        setReadyState(false);
        setError(
          'The original result was read, but its local recovery record is busy or changed in another tab. It has been kept. Reload saved plans and check again.',
        );
        return;
      }
      retain(null, null);
      if (outcome === 'confirmed') {
        if (originalPayload) committed.current(originalPayload, row.revision);
        setNotice(
          originalPayload
            ? 'The original funding change is confirmed in saved history. No funds moved.'
            : 'The original funding change is confirmed in saved history. Open the saved plan explicitly to inspect it; your current editor was not replaced. No funds moved.',
        );
      } else
        setError(
          'A different or later funding revision is saved. The original expected revision is fenced. Your editor is preserved. Open that saved plan or start a new draft before saving again.',
        );
    } catch (cause) {
      if (current(request))
        setError(cause instanceof Error ? cause.message : unknownSave);
    } finally {
      finish(request);
    }
  };
  return {
    plans,
    phase,
    pending,
    pendingStop,
    error,
    notice,
    setError,
    setNotice,
    load,
    save,
    recover,
    ownerScope,
    ready,
    writeBlocked: !ready || pending !== null || pendingStop !== null,
    hasOriginalPayload,
    canRetry:
      pending !== null && pendingStop === null && hasOriginalPayload && ready,
    stopOriginalSave: (approved: boolean) => stopOriginal('start', approved),
    recoverStop: () => stopOriginal('recover'),
    retryStop: () => stopOriginal('retry'),
    retry: () =>
      retained.current ? save(retained.current) : Promise.resolve(),
    cancel: () => cancel(false),
  };
}
