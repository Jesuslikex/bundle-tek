'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isJitoBundleEvent,
  jitoEventMatchesManifest,
  type JitoBundleEvent,
} from '@/lib/jito-bundle-events';
import type { JitoBundleManifest } from '@/lib/jito-bundle';

export function useJitoBundleActivity(
  revision: number | string,
  manifest?: JitoBundleManifest,
) {
  const [events, setEvents] = useState<JitoBundleEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [baselinePending, setBaselinePending] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const baselineBusy = useRef(false);
  const read = useCallback(
    async (after: string | null) => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (after) params.set('cursor', after);
        if (manifest) params.set('bundleId', manifest.id);
        const response = await fetch(
          `/api/imported-projects/jito-activity${params.size ? '?' + params.toString() : ''}`,
          {
            cache: 'no-store',
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(10000),
            ]),
          },
        );
        const data = (await response.json()) as {
          events: JitoBundleEvent[];
          nextCursor: string | null;
          baselinePending: boolean;
          error?: string;
        };
        if (
          !response.ok ||
          typeof data.baselinePending !== 'boolean' ||
          !Array.isArray(data.events) ||
          data.events.length > 50 ||
          data.events.some(
            (r) =>
              !isJitoBundleEvent(r) ||
              (manifest && !jitoEventMatchesManifest(r, manifest)),
          ) ||
          new Set(data.events.map((r) => r.id)).size !== data.events.length ||
          (data.nextCursor !== null &&
            (typeof data.nextCursor !== 'string' ||
              !/^[a-f0-9]{32}$/.test(data.nextCursor)))
        )
          throw new Error(data.error || 'Jito bundle activity unavailable.');
        if (controller.signal.aborted || pending.current !== controller) return;
        setEvents((prior) =>
          after
            ? [
                ...prior,
                ...data.events.filter((r) => !prior.some((p) => p.id === r.id)),
              ]
            : data.events,
        );
        setCursor(data.nextCursor);
        setBaselinePending(data.baselinePending);
        setError('');
      } catch (e) {
        if (!controller.signal.aborted && pending.current === controller)
          setError(
            e instanceof Error
              ? e.message
              : 'Jito bundle activity unavailable.',
          );
      } finally {
        if (!controller.signal.aborted && pending.current === controller)
          setLoading(false);
      }
    },
    [manifest],
  );
  const baseline = useCallback(async () => {
    if (manifest || loading || baselineBusy.current) return;
    baselineBusy.current = true;
    const controller = new AbortController();
    pending.current?.abort();
    pending.current = controller;
    setLoading(true);
    try {
      const response = await fetch('/api/imported-projects/jito-activity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'record-baselines', approved: true }),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(10000),
        ]),
      });
      const data = (await response.json()) as {
        created: number;
        baselinePending: boolean;
        error?: string;
      };
      if (
        !response.ok ||
        !Number.isSafeInteger(data.created) ||
        data.created < 0 ||
        data.created > 50 ||
        typeof data.baselinePending !== 'boolean'
      )
        throw new Error(data.error || 'Bundle baselines unavailable.');
      if (controller.signal.aborted || pending.current !== controller) return;
      await read(null);
    } catch (e) {
      if (!controller.signal.aborted && pending.current === controller)
        setError(
          e instanceof Error ? e.message : 'Bundle baselines unavailable.',
        );
    } finally {
      if (!controller.signal.aborted && pending.current === controller)
        setLoading(false);
      baselineBusy.current = false;
    }
  }, [manifest, loading, read]);
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
    baselinePending,
    baseline: () => {
      if (!loading) void baseline();
    },
    beginRefresh: () => setLoading(true),
    older: () => {
      if (cursor && !loading) void read(cursor);
    },
  };
}
