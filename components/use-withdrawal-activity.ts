'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  validatedWithdrawalActivity,
  type WithdrawalActivityEvent,
} from '@/lib/withdrawal-activity';
export function useWithdrawalActivity(revision: number) {
  const [events, setEvents] = useState<WithdrawalActivityEvent[]>([]),
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
        '/api/wallet-workspace/withdrawals/activity' +
          (after ? '?cursor=' + encodeURIComponent(after) : ''),
        {
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(15000),
          ]),
        },
      );
      const data = (await response.json()) as {
        events: unknown[];
        nextCursor: string | null;
        error?: string;
      };
      if (
        !response.ok ||
        !Array.isArray(data.events) ||
        data.events.length > 50 ||
        (data.nextCursor !== null &&
          (typeof data.nextCursor !== 'string' ||
            !/^[1-9]\d{0,15}$/.test(data.nextCursor) ||
            !Number.isSafeInteger(Number(data.nextCursor))))
      )
        throw new Error(data.error || 'Withdrawal activity unavailable.');
      const rows = await Promise.all(
        data.events.map(validatedWithdrawalActivity),
      );
      if (new Set(rows.map((e) => e.sequence)).size !== rows.length)
        throw new Error('Duplicate withdrawal events.');
      if (controller.signal.aborted || pending.current !== controller) return;
      setEvents((prior) =>
        after
          ? [
              ...prior,
              ...rows.filter(
                (e) => !prior.some((p) => p.sequence === e.sequence),
              ),
            ]
          : rows,
      );
      setCursor(data.nextCursor);
      setError('');
    } catch (e) {
      if (!controller.signal.aborted && pending.current === controller)
        setError(
          e instanceof Error ? e.message : 'Withdrawal activity unavailable.',
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
