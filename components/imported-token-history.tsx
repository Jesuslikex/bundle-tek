'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ImportedTokenEvent } from '@/lib/imported-token-project';

type Page = {
  projectId: string;
  revision: number;
  events: ImportedTokenEvent[];
  nextCursor: string | null;
  error?: string;
};
const labels = {
  'project.import': 'Token imported',
  'project.refresh': 'Identity refreshed',
  'project.archive': 'Project archived',
  'project.restore': 'Project restored',
  'project.settings': 'Trade settings saved',
} as const;
export function ImportedTokenHistory({
  id,
  revision,
}: {
  id: string;
  revision: number;
}) {
  const [events, setEvents] = useState<ImportedTokenEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [head, setHead] = useState(revision);
  const pending = useRef<AbortController | null>(null);
  const accept = useCallback(
    (body: Page, after: string | null) => {
      if (
        body.projectId !== id ||
        !Array.isArray(body.events) ||
        !Number.isSafeInteger(body.revision) ||
        body.revision < revision ||
        body.events.some(
          (event) =>
            event.projectId !== id ||
            !Number.isSafeInteger(event.revision) ||
            event.revision < 1 ||
            event.revision > body.revision ||
            (after !== null && event.revision >= Number(after)),
        )
      )
        throw new Error(
          'History response does not match this project. Reload its details.',
        );
      setEvents((previous) =>
        after
          ? [
              ...previous,
              ...body.events.filter(
                (event) => !previous.some((row) => row.id === event.id),
              ),
            ]
          : body.events,
      );
      setCursor(body.nextCursor);
      setHead(body.revision);
    },
    [id, revision],
  );
  useEffect(() => {
    const controller = new AbortController();
    pending.current = controller;
    void fetch(`/api/imported-projects/events?id=${encodeURIComponent(id)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as Page;
        if (!response.ok) throw new Error(body.error || 'History unavailable.');
        if (!controller.signal.aborted) accept(body, null);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'History unavailable.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => pending.current?.abort();
    // Parent keys the panel by project id and revision, discarding stale pages on changes.
  }, [id, revision, accept]);
  async function read(after: string | null) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/imported-projects/events?id=${encodeURIComponent(id)}${after ? `&cursor=${encodeURIComponent(after)}` : ''}`,
        { cache: 'no-store', signal: controller.signal },
      );
      const body = (await response.json()) as Page;
      if (!response.ok) throw new Error(body.error || 'History unavailable.');
      if (!controller.signal.aborted) accept(body, after);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'History unavailable.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="Imported project history">
      <div className="wallet-roster-actions">
        <h3>Project history</h3>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void read(null)}
        >
          Reload imported history
        </Button>
      </div>
      <p>
        Saved project revisions and identity observations. These are not trade
        receipts.
      </p>
      {head > revision && (
        <output>
          Newer changes exist. Reload imported projects for the latest details.
        </output>
      )}
      {error && <p role="alert">{error}</p>}
      {busy && <output>Loading project history…</output>}
      {!busy && !error && !events.length && <p>No recorded revisions.</p>}
      <ol className="warmup-history imported-history">
        {events.map((event) => (
          <li key={event.id}>
            <strong>
              {labels[event.type]} · revision {event.revision}
            </strong>
            <p>{new Date(event.createdAt).toLocaleString()}</p>
            <details>
              <summary>Identity snapshot at revision {event.revision}</summary>
              <p>
                {event.document.token.name} ({event.document.token.symbol}) ·{' '}
                {event.document.token.chain}
              </p>
              <code className="warmup-address">
                {event.document.token.address}
              </code>
              <p>
                Supply in raw units: {event.document.token.totalSupplyRaw} ·{' '}
                {event.document.token.decimals} decimals
              </p>
              <p>
                Identity observed{' '}
                {new Date(event.document.token.observedAt).toLocaleString()} ·{' '}
                {event.document.token.source}
              </p>
              <p>
                Archive, restore and trade settings retain the preceding
                identity observation.
              </p>
              {event.document.tradeSettings && (
                <p>
                  Saved trade: {event.document.tradeSettings.side}{' '}
                  {event.document.tradeSettings.amount} ·{' '}
                  {event.document.tradeSettings.wallet} · wallet revision{' '}
                  {event.document.tradeSettings.walletRevision}
                </p>
              )}
            </details>
          </li>
        ))}
      </ol>
      {cursor && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void read(cursor)}
        >
          Load older imported revisions
        </Button>
      )}
    </section>
  );
}
