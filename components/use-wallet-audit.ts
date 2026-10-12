'use client';
import { useEffect, useRef, useState } from 'react';
import type { WalletAuditEvent } from '@/lib/distribution-audit';

export function useWalletAudit(
  query: string | null,
  externalRevision = 0,
  allPages = false,
) {
  const [revision, setRevision] = useState(0);
  const identity = `${query}\n${externalRevision}\n${revision}`;
  const [state, setState] = useState({
    identity: '',
    events: [] as WalletAuditEvent[],
    cursor: null as string | null,
    error: '',
    loading: true,
  });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    if (query !== null)
      void (async () => {
        try {
          let cursor: string | null = null;
          const events: WalletAuditEvent[] = [];
          do {
            const response = await fetch(
              `/api/wallet/events?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
              { cache: 'no-store', signal: active.signal },
            );
            const data = (await response.json()) as {
              events?: WalletAuditEvent[];
              nextCursor?: string | null;
              error?: string;
            };
            if (
              !response.ok ||
              !Array.isArray(data.events) ||
              (data.nextCursor !== null && typeof data.nextCursor !== 'string')
            )
              throw new Error(data.error || 'Wallet history unavailable.');
            events.push(...data.events);
            cursor = data.nextCursor ?? null;
            if (
              events.length > 1000 ||
              (allPages && events.length === 1000 && cursor)
            )
              throw new Error('Distribution history exceeds its review limit.');
          } while (allPages && cursor && !active.signal.aborted);
          if (!active.signal.aborted)
            setState({ identity, events, cursor, error: '', loading: false });
        } catch (e) {
          if (!active.signal.aborted)
            setState({
              identity,
              events: [],
              cursor: null,
              error:
                e instanceof Error ? e.message : 'Wallet history unavailable.',
              loading: false,
            });
        }
      })();
    return () => active.abort();
  }, [query, identity, allPages]);
  async function older() {
    const active = controller.current,
      cursor = state.cursor;
    if (
      !active ||
      active.signal.aborted ||
      !cursor ||
      state.identity !== identity ||
      state.loading
    )
      return;
    setState((current) => ({ ...current, loading: true }));
    try {
      const response = await fetch(
        `/api/wallet/events?${query}&cursor=${encodeURIComponent(cursor)}`,
        { cache: 'no-store', signal: active.signal },
      );
      const data = (await response.json()) as {
        events: WalletAuditEvent[];
        nextCursor: string | null;
        error?: string;
      };
      if (
        !response.ok ||
        !Array.isArray(data.events) ||
        (data.nextCursor !== null && typeof data.nextCursor !== 'string')
      )
        throw new Error(data.error || 'Wallet history unavailable.');
      if (!active.signal.aborted)
        setState((current) => ({
          ...current,
          events: [
            ...current.events,
            ...data.events.filter(
              (event) => !current.events.some((old) => old.id === event.id),
            ),
          ],
          cursor: data.nextCursor,
          error: '',
          loading: false,
        }));
    } catch (e) {
      if (!active.signal.aborted)
        setState((current) => ({
          ...current,
          error: e instanceof Error ? e.message : 'Wallet history unavailable.',
          loading: false,
        }));
    }
  }
  const current = query !== null && state.identity === identity;
  return {
    events: current ? state.events : [],
    cursor: current ? state.cursor : null,
    error: current ? state.error : '',
    loading: query !== null && (!current || state.loading),
    ready: current && !state.loading && !state.error,
    refresh: () => setRevision((value) => value + 1),
    older,
  };
}
