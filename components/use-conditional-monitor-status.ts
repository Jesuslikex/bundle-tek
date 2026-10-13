'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  createRetainedRunStatusFeed,
  type RetainedRunFeedState,
} from '@/lib/retained-run-status-feed';
import {
  decodeConditionalMonitorPage,
  type ConditionalMonitorPage,
} from '@/lib/conditional-monitor';

export function useConditionalMonitorStatus(
  projectId: string,
  projectRevision: number,
  archived: boolean,
  busy: boolean,
  onSnapshot: (page: ConditionalMonitorPage) => void,
) {
  const [state, setState] = useState<RetainedRunFeedState>({
    status: 'off',
    reason: '',
    reads: 0,
    retryInMs: null,
  });
  const [error, setError] = useState('');
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
          ? 'Monitoring update in progress.'
          : document.hidden
            ? 'Tab hidden. Resumes when visible.'
            : !navigator.onLine
              ? 'Browser offline. Resumes when connected.'
              : null,
      read: async (signal) => {
        try {
          const response = await fetch(
            '/api/imported-projects/conditional-monitor?' +
              new URLSearchParams({ projectId }),
            {
              cache: 'no-store',
              signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
            },
          );
          const body: unknown = await response.json().catch(() => null);
          if (!response.ok) throw new Error('Monitoring notices unavailable.');
          const page = decodeConditionalMonitorPage(body, projectId);
          if (signal.aborted || context.current.busy) return false;
          context.current.onSnapshot(page);
          setError('');
          return true;
        } catch {
          if (!signal.aborted)
            setError(
              'Monitoring notices unavailable. Retained notices remain visible.',
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
  }, [projectId, projectRevision, archived]);
  useEffect(() => {
    feed.current?.availabilityChanged();
  }, [busy]);
  return {
    state,
    error,
    start: () => feed.current?.start(),
    stop: () => feed.current?.stop(),
  };
}
