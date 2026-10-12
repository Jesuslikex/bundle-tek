'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WarmupActivityEvent } from '@/lib/wallet-warmup-storage';
export function useWarmupActivity(revision: number) {
  const [events, setEvents] = useState<WarmupActivityEvent[]>([]);
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
        `/api/wallet-workspace/warmup/activity${after ? `?cursor=${encodeURIComponent(after)}` : ''}`,
        { cache: 'no-store', signal: controller.signal },
      );
      const data = (await response.json()) as {
        events?: WarmupActivityEvent[];
        nextCursor: string | null;
        error?: string;
      };
      if (!response.ok || !Array.isArray(data.events))
        throw new Error(data.error || 'Warmup activity unavailable.');
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
          e instanceof Error ? e.message : 'Warmup activity unavailable.',
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
