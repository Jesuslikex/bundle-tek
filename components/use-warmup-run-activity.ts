'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WarmupRunActivityEvent } from '@/lib/warmup-history-run-events';
export function useWarmupRunActivity(revision: number) {
  const [events, setEvents] = useState<WarmupRunActivityEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const read = useCallback(async (after: string | null) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    try {
      const response = await fetch(
        `/api/wallet-workspace/warmup/runs/activity${after ? `?cursor=${encodeURIComponent(after)}` : ''}`,
        { cache: 'no-store', signal: controller.signal },
      );
      const data = (await response.json()) as {
        events?: WarmupRunActivityEvent[];
        nextCursor: string | null;
        error?: string;
        executionAllowed: boolean;
      };
      if (
        !response.ok ||
        !Array.isArray(data.events) ||
        data.executionAllowed !== false
      )
        throw new Error(data.error || 'Warmup run activity unavailable.');
      if (!controller.signal.aborted && pending.current === controller) {
        const incoming = data.events;
        setEvents((rows) =>
          after
            ? [
                ...rows,
                ...incoming.filter((e) => !rows.some((r) => r.id === e.id)),
              ]
            : incoming,
        );
        setCursor(data.nextCursor);
        setError('');
      }
    } catch (e) {
      if (!controller.signal.aborted && pending.current === controller)
        setError(
          e instanceof Error ? e.message : 'Warmup run activity unavailable.',
        );
    } finally {
      if (!controller.signal.aborted && pending.current === controller)
        setLoading(false);
    }
  }, []);
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(() => {
      if (current) return read(null);
    });
    return () => {
      current = false;
      pending.current?.abort();
    };
  }, [read, revision]);
  return {
    events,
    cursor,
    loading,
    error,
    older: () => {
      if (cursor && !loading) {
        setLoading(true);
        void read(cursor);
      }
    },
    beginRefresh: () => setLoading(true),
  };
}
