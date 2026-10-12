'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  decodeSessionJobEventPage,
  type SessionJobEvent,
} from '@/lib/session-preparation-job-events';
export function useSessionJobActivity(
  revision: number,
  projectId?: string,
  sessionId?: string,
) {
  const [events, setEvents] = useState<SessionJobEvent[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const oldestSequence = useRef<number | undefined>(undefined);
  const pending = useRef<AbortController | null>(null);
  const read = useCallback(
    async (after: string | null) => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      setLoading(true);
      try {
        const response = await fetch(
          `/api/imported-projects/session-job-events?${new URLSearchParams({ ...(projectId ? { projectId } : {}), ...(sessionId ? { sessionId } : {}), ...(after ? { cursor: after } : {}) })}`,
          {
            cache: 'no-store',
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(10000),
            ]),
          },
        );
        const data = (await response.json()) as {
          events: SessionJobEvent[];
          nextCursor: string | null;
          error?: string;
        };
        if (!response.ok)
          throw new Error(data.error || 'Preparation job history unavailable.');
        const page = decodeSessionJobEventPage(
          data,
          projectId,
          sessionId,
          after ? oldestSequence.current : undefined,
        );
        if (controller.signal.aborted || pending.current !== controller) return;
        setEvents((prior) =>
          after
            ? [
                ...prior,
                ...page.events.filter(
                  (row) => !prior.some((old) => old.id === row.id),
                ),
              ]
            : page.events,
        );
        oldestSequence.current = page.events.at(-1)?.sequence;
        setCursor(page.nextCursor);
        setError('');
      } catch (error) {
        if (!controller.signal.aborted && pending.current === controller)
          setError(
            error instanceof Error
              ? error.message
              : 'Preparation job history unavailable.',
          );
      } finally {
        if (!controller.signal.aborted && pending.current === controller)
          setLoading(false);
      }
    },
    [projectId, sessionId],
  );
  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(() => {
      if (!disposed) void read(null);
    });
    return () => {
      disposed = true;
      pending.current?.abort();
    };
  }, [revision, read]);
  return {
    events,
    cursor,
    loading,
    error,
    beginRefresh: () => setLoading(true),
    older: () => {
      if (cursor && !loading) void read(cursor);
    },
  };
}
