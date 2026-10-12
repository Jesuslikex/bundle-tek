'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isImportedSigningEvent,
  type ImportedSigningEvent,
} from '@/lib/imported-signing-events';
export function useImportedSigningActivity(revision: number) {
  const [events, setEvents] = useState<ImportedSigningEvent[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const read = useCallback(async (after: string | null) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/imported-projects/signing-activity${after ? '?cursor=' + encodeURIComponent(after) : ''}`,
        {
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]),
        },
      );
      const data = (await response.json()) as {
        events: ImportedSigningEvent[];
        nextCursor: string | null;
        error?: string;
      };
      if (
        !response.ok ||
        !Array.isArray(data.events) ||
        data.events.length > 50 ||
        data.events.some((row) => !isImportedSigningEvent(row)) ||
        new Set(data.events.map((row) => row.id)).size !== data.events.length ||
        (data.nextCursor !== null && !/^[a-f0-9]{32}$/.test(data.nextCursor))
      )
        throw new Error(data.error || 'Imported swap activity unavailable.');
      if (controller.signal.aborted || pending.current !== controller) return;
      setEvents((prior) =>
        after
          ? [
              ...prior,
              ...data.events.filter(
                (row) => !prior.some((old) => old.id === row.id),
              ),
            ]
          : data.events,
      );
      setCursor(data.nextCursor);
      setError('');
    } catch (error) {
      if (!controller.signal.aborted && pending.current === controller)
        setError(
          error instanceof Error
            ? error.message
            : 'Imported swap activity unavailable.',
        );
    } finally {
      if (!controller.signal.aborted && pending.current === controller)
        setLoading(false);
    }
  }, []);
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
