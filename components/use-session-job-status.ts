'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  createRetainedRunStatusFeed,
  type RetainedRunFeedState,
} from '@/lib/retained-run-status-feed';
export function useSessionJobStatus(
  projectId: string,
  sessionId: string,
  busy: boolean,
  onSnapshot: (value: unknown) => void,
) {
  const [state, setState] = useState<RetainedRunFeedState>({
    status: 'off',
    reason: '',
    reads: 0,
    retryInMs: null,
  });
  const [readAt, setReadAt] = useState<number | null>(null),
    [error, setError] = useState('');
  const context = useRef({ busy, onSnapshot });
  useLayoutEffect(() => {
    context.current = { busy, onSnapshot };
  }, [busy, onSnapshot]);
  const feed = useRef<ReturnType<typeof createRetainedRunStatusFeed> | null>(
    null,
  );
  useEffect(() => {
    const controller = createRetainedRunStatusFeed({
      unavailable: () =>
        context.current.busy
          ? 'Job panel closed or update in progress.'
          : document.hidden
            ? 'Tab hidden. Resumes when visible.'
            : !navigator.onLine
              ? 'Browser offline. Resumes when connected.'
              : null,
      read: async (signal) => {
        try {
          const response = await fetch(
            `/api/imported-projects/session-preparation-jobs?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}`,
            {
              cache: 'no-store',
              signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
            },
          );
          const value = await response.json();
          if (!response.ok)
            throw new Error(
              (value as { error?: string })?.error ||
                'Saved preparation job status unavailable.',
            );
          if (signal.aborted || context.current.busy) return false;
          context.current.onSnapshot(value);
          setReadAt(Date.now());
          setError('');
          return true;
        } catch (e) {
          if (!signal.aborted)
            setError(
              e instanceof Error
                ? e.message
                : 'Saved preparation job status unavailable.',
            );
          return false;
        }
      },
      onState: setState,
    });
    feed.current = controller;
    const availability = () => controller.availabilityChanged();
    document.addEventListener('visibilitychange', availability);
    window.addEventListener('online', availability);
    window.addEventListener('offline', availability);
    return () => {
      controller.destroy();
      document.removeEventListener('visibilitychange', availability);
      window.removeEventListener('online', availability);
      window.removeEventListener('offline', availability);
      if (feed.current === controller) feed.current = null;
    };
  }, [projectId, sessionId]);
  useEffect(() => {
    feed.current?.availabilityChanged();
  }, [busy]);
  return {
    state,
    readAt,
    error,
    start: () => feed.current?.start(),
    stop: () => feed.current?.stop(),
  };
}
