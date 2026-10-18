'use client';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';
import type { SavedFunding } from '@/lib/funding-plan';
import {
  decodeFundingList,
  decodeSavedFunding,
  fundingMutationOutcome,
  fundingResponse,
  fundingWriteResponse,
  FundingMutationRejected,
  type FundingMutation,
} from '@/lib/funding-plan-storage';

type Phase = 'load' | 'save' | 'recover';
type RequestState = {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  phase: Phase;
};
export const FUNDING_REQUEST_TIMEOUT_MS = 30_000;
const unknownSave =
  'Save outcome unknown. The server may have saved it. Check the original draft before continuing; no funds were moved.';

export function useFundingPlanStorage(
  onCommitted: (attempt: FundingMutation, revision: number) => void,
) {
  const [plans, setPlans] = useState<SavedFunding[]>([]);
  const [phase, setPhase] = useState<Phase | null>('load');
  const [pending, setPending] = useState<FundingMutation | null>(null);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const active = useRef<RequestState | null>(null);
  const retained = useRef<FundingMutation | null>(null);
  const committed = useRef(onCommitted);
  useEffect(() => {
    committed.current = onCommitted;
  }, [onCommitted]);

  const cancel = useCallback((timedOut = false) => {
    const request = active.current;
    if (!request) return;
    active.current = null;
    clearTimeout(request.timer);
    request.controller.abort();
    setPhase(null);
    setError(
      retained.current
        ? unknownSave
        : timedOut
          ? 'Loading funding drafts timed out. Reload saved plans to try again.'
          : 'Loading cancelled. Your editable draft is preserved.',
    );
  }, []);
  const begin = useCallback(
    (next: Phase) => {
      if (active.current) return null;
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
  const retain = (value: FundingMutation | null) => {
    retained.current = value;
    setPending(value);
  };
  const load = async () => {
    if (retained.current) return;
    const request = begin('load');
    if (!request) return;
    try {
      const response = await fetch('/api/funding', {
        cache: 'no-store',
        signal: request.controller.signal,
      });
      const rows = decodeFundingList(await fundingResponse(response));
      if (active.current === request) setPlans(rows);
    } catch (cause) {
      if (active.current === request)
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
    let mounted = true;
    void Promise.resolve().then(() => {
      if (mounted) startLoading();
    });
    return () => {
      mounted = false;
      const request = active.current;
      active.current = null;
      if (request) {
        clearTimeout(request.timer);
        request.controller.abort();
      }
    };
  }, []);

  const save = async (attempt: FundingMutation) => {
    if (retained.current && retained.current !== attempt) return;
    const retryingUnknown = retained.current !== null;
    const request = begin('save');
    if (!request) return;
    // Preserve the exact immutable payload before dispatch, even if its response is lost.
    const captured: FundingMutation = JSON.parse(JSON.stringify(attempt));
    retain(captured);
    try {
      const response = await fetch('/api/funding', {
        method: 'POST',
        signal: request.controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...captured,
          document: captured.action === 'save' ? captured.document : undefined,
        }),
      });
      const result = await fundingWriteResponse(response);
      if (
        result.id !== captured.id ||
        result.revision !== captured.expectedRevision + 1
      )
        throw new Error(
          'The save acknowledgement did not match the original draft.',
        );
      if (active.current !== request) return;
      retain(null);
      committed.current(captured, Number(result.revision));
      finish(request);
      // Read-only refresh. A failed refresh cannot repeat the mutation.
      void load();
      setNotice(
        captured.action === 'save'
          ? 'Funding draft saved. No funds moved.'
          : captured.action === 'archive'
            ? 'Funding draft archived.'
            : 'Funding draft restored.',
      );
    } catch (cause) {
      if (active.current === request) {
        if (cause instanceof FundingMutationRejected && !retryingUnknown) {
          retain(null);
          // A known revision conflict invalidates the cached revision for review.
          if (cause.status === 409)
            setPlans((previous) =>
              previous.filter((row) => row.id !== captured.id),
            );
          setError(cause.message);
        } else
          setError(
            (cause instanceof Error ? cause.message + ' ' : '') + unknownSave,
          );
      }
    } finally {
      finish(request);
    }
  };
  const recover = async () => {
    const attempt = retained.current;
    if (!attempt) return;
    const request = begin('recover');
    if (!request) return;
    try {
      const response = await fetch(
        '/api/funding?id=' + encodeURIComponent(attempt.id),
        { cache: 'no-store', signal: request.controller.signal },
      );
      if (response.status === 404)
        throw new Error(
          'The original draft is not visible yet. Its save may still finish. Check again or retry the exact same request.',
        );
      const body = await fundingResponse(response);
      const row = decodeSavedFunding(body.plan),
        outcome = fundingMutationOutcome(attempt, row);
      if (active.current !== request) return;
      if (outcome === 'unknown')
        throw new Error(
          'The saved revision has not advanced yet. Its save may still finish. Check again or retry the exact same request.',
        );
      setPlans((previous) =>
        [row, ...previous.filter((value) => value.id !== row.id)].slice(0, 100),
      );
      retain(null);
      if (outcome === 'confirmed') {
        committed.current(attempt, row.revision);
        setNotice(
          'The original funding change is confirmed in saved history. No funds moved.',
        );
      } else
        setError(
          'A different or later funding revision is saved. Your editor is preserved. Open that saved plan or start a new draft before saving again.',
        );
    } catch (cause) {
      if (active.current === request)
        setError(cause instanceof Error ? cause.message : unknownSave);
    } finally {
      finish(request);
    }
  };
  return {
    plans,
    phase,
    pending,
    error,
    notice,
    setError,
    setNotice,
    load,
    save,
    recover,
    retry: () =>
      retained.current ? save(retained.current) : Promise.resolve(),
    cancel: () => cancel(false),
  };
}
