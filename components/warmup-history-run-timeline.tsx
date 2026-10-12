'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import {
  historyRunEventLabel,
  type WarmupHistoryRunEvent,
} from '@/lib/warmup-history-run-events';
export function WarmupHistoryRunTimeline({
  id,
  revision,
  initiallyOpen = false,
}: {
  id: string;
  revision: number;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <section aria-label="History run timeline">
      <Button variant="outline" onClick={() => setOpen((value) => !value)}>
        {open ? 'Close run timeline' : 'Open run timeline'}
      </Button>
      {open && <Timeline key={`${id}:${revision}`} id={id} />}
    </section>
  );
}
function Timeline({ id }: { id: string }) {
  const [events, setEvents] = useState<WarmupHistoryRunEvent[]>([]),
    [before, setBefore] = useState<number | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    pending.current = controller;
    void fetch(
      `/api/wallet-workspace/warmup/runs/events?id=${encodeURIComponent(id)}`,
      { cache: 'no-store', signal: controller.signal },
    )
      .then(async (response) => {
        const data = (await response.json()) as {
          id: string;
          events: WarmupHistoryRunEvent[];
          nextBefore: number | null;
          executionAllowed: boolean;
          error?: string;
        };
        if (
          !response.ok ||
          data.id !== id ||
          data.executionAllowed !== false ||
          !Array.isArray(data.events) ||
          data.events.some((event) => event.runId !== id)
        )
          throw new Error(data.error || 'Run timeline unavailable.');
        if (!controller.signal.aborted) {
          setEvents(data.events);
          setBefore(data.nextBefore);
          setError('');
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Run timeline unavailable.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => pending.current?.abort();
  }, [id]);
  async function older() {
    if (before === null) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/wallet-workspace/warmup/runs/events?id=${encodeURIComponent(id)}&before=${before}`,
        { cache: 'no-store', signal: controller.signal },
      );
      const data = (await response.json()) as {
        id: string;
        events: WarmupHistoryRunEvent[];
        nextBefore: number | null;
        executionAllowed: boolean;
        error?: string;
      };
      if (
        !response.ok ||
        data.id !== id ||
        data.executionAllowed !== false ||
        !Array.isArray(data.events) ||
        data.events.some(
          (event) => event.runId !== id || event.revision >= before,
        )
      )
        throw new Error(data.error || 'Older events unavailable.');
      if (!controller.signal.aborted) {
        setEvents((current) => [
          ...current,
          ...data.events.filter(
            (event) => !current.some((e) => e.revision === event.revision),
          ),
        ]);
        setBefore(data.nextBefore);
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Run timeline unavailable.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <div>
      <p>
        Saved run transitions and wallet-check results. Earlier runs have a
        retained-state baseline; actions before timeline tracking were not
        reconstructed.
      </p>
      {error && <p role="alert">{error}</p>}
      <ol>
        {events.map((event) => (
          <li key={event.revision}>
            <strong>
              {historyRunEventLabel(event.type)} · revision {event.revision}
            </strong>
            <p>
              {new Date(event.createdAt).toLocaleString()} · {event.state} ·{' '}
              {event.completedCount} checked · {event.errorCount} failed
            </p>
            {event.walletAddress && (
              <p className="warmup-address">{event.walletAddress}</p>
            )}
            {event.result?.error && <p>{event.result.error}</p>}
            {event.result?.observation && (
              <p>
                Retained observation: {event.result.observation.nativeBalance}{' '}
                {event.result.observation.currency} ·{' '}
                {event.result.observation.source} · block/slot{' '}
                {event.result.observation.block}
              </p>
            )}
          </li>
        ))}
      </ol>
      {events.length === 0 && !busy && <p>No recorded transitions.</p>}
      {busy && <output>Loading run timeline…</output>}
      {before !== null && (
        <Button variant="outline" disabled={busy} onClick={() => void older()}>
          Older run events
        </Button>
      )}
    </div>
  );
}
