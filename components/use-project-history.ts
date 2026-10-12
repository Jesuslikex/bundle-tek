'use client';
import { useEffect, useRef, useState } from 'react';
import type { ProjectEvent } from '@/lib/workspace-project';
export function useProjectHistory(revision: number) {
  const [events, setEvents] = useState<ProjectEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  async function read(controller: AbortController, after: string | null) {
    try {
      const response = await fetch(
        `/api/projects/events${after ? `?cursor=${encodeURIComponent(after)}` : ''}`,
        { cache: 'no-store', signal: controller.signal },
      );
      const body = (await response.json()) as {
        events?: ProjectEvent[];
        nextCursor: string | null;
        error?: string;
      };
      if (!response.ok || !Array.isArray(body.events))
        throw new Error(body.error || 'Project history unavailable.');
      if (pending.current === controller && !controller.signal.aborted) {
        setEvents((rows) =>
          after
            ? [
                ...rows,
                ...body.events!.filter((e) => !rows.some((r) => r.id === e.id)),
              ]
            : body.events!,
        );
        setCursor(body.nextCursor);
        setError('');
      }
    } catch (error) {
      if (pending.current === controller && !controller.signal.aborted)
        setError(
          error instanceof Error
            ? error.message
            : 'Project history unavailable.',
        );
    } finally {
      if (pending.current === controller && !controller.signal.aborted)
        setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    pending.current = controller;
    void fetch('/api/projects/events', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          events?: ProjectEvent[];
          nextCursor: string | null;
          error?: string;
        };
        if (!response.ok || !Array.isArray(body.events))
          throw new Error(body.error || 'Project history unavailable.');
        if (pending.current === controller && !controller.signal.aborted) {
          setEvents(body.events);
          setCursor(body.nextCursor);
          setError('');
        }
      })
      .catch((error) => {
        if (pending.current === controller && !controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : 'Project history unavailable.',
          );
      })
      .finally(() => {
        if (pending.current === controller && !controller.signal.aborted)
          setLoading(false);
      });
    return () => {
      pending.current?.abort();
    };
  }, [revision]);
  async function older() {
    if (!cursor || loading) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    await read(controller, cursor);
  }
  return {
    events,
    loading,
    error,
    cursor,
    older,
    beginRefresh: () => setLoading(true),
  };
}
