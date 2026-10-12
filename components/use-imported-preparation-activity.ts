'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SavedSwapPreparation } from '@/lib/imported-swap-preparation-history';
export function useImportedPreparationActivity(revision: number) {
  const [events, setEvents] = useState<SavedSwapPreparation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const read = useCallback(async (after: string | null) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/imported-projects/preparation-activity${after ? `?cursor=${encodeURIComponent(after)}` : ''}`,
        {
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]),
        },
      );
      const data = (await response.json()) as {
        executionAllowed: boolean;
        preparations: SavedSwapPreparation[];
        nextCursor: string | null;
        error?: string;
      };
      if (
        !response.ok ||
        data.executionAllowed !== false ||
        !Array.isArray(data.preparations) ||
        data.preparations.some(
          (row) =>
            row.document.executionAllowed !== false ||
            row.document.instructionsVerified !== false,
        )
      )
        throw new Error(data.error || 'Preparation activity unavailable.');
      if (!controller.signal.aborted && pending.current === controller) {
        setEvents((previous) =>
          after
            ? [
                ...previous,
                ...data.preparations.filter(
                  (row) => !previous.some((old) => old.id === row.id),
                ),
              ]
            : data.preparations,
        );
        setCursor(data.nextCursor);
        setError('');
      }
    } catch (e) {
      if (!controller.signal.aborted && pending.current === controller)
        setError(
          e instanceof Error ? e.message : 'Preparation activity unavailable.',
        );
    } finally {
      if (!controller.signal.aborted && pending.current === controller)
        setLoading(false);
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void read(null);
    });
    return () => {
      cancelled = true;
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
