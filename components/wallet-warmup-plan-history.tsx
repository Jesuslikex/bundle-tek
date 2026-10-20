'use client';
import { formatWarmupDelay, warmupDelaySeconds } from '@/lib/wallet-warmup';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { WarmupPlanEvent } from '@/lib/wallet-warmup-storage';
const labels = {
  'plan.create': 'Plan created',
  'plan.save': 'Configuration saved',
  'plan.archive': 'Plan archived',
  'plan.restore': 'Plan restored',
};
type Page = {
  planId: string;
  revision: number;
  events: WarmupPlanEvent[];
  nextCursor: string | null;
  error?: string;
};
export function WalletWarmupPlanHistory({
  id,
  revision,
  name,
}: {
  id: string;
  revision: number;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<WarmupPlanEvent[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [head, setHead] = useState(revision);
  const pending = useRef<AbortController | null>(null);
  const read = useCallback(
    async (after: string | null) => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      try {
        const response = await fetch(
          `/api/wallet-workspace/warmup/events?id=${encodeURIComponent(id)}${after ? '&cursor=' + encodeURIComponent(after) : ''}`,
          { cache: 'no-store', signal: controller.signal },
        );
        const body = (await response.json()) as Page;
        if (!response.ok)
          throw new Error(body.error || 'Warmup history unavailable.');
        if (
          body.planId !== id ||
          !Number.isSafeInteger(body.revision) ||
          body.revision < revision ||
          !Array.isArray(body.events) ||
          body.events.some(
            (e) =>
              e.planId !== id ||
              !Number.isSafeInteger(e.revision) ||
              e.revision < 1 ||
              e.revision > body.revision ||
              (after !== null && e.revision >= Number(after)) ||
              !Object.hasOwn(labels, e.type),
          )
        )
          throw new Error(
            'History does not match this saved warmup. Reload plans.',
          );
        if (!controller.signal.aborted) {
          setEvents((old) =>
            after
              ? [
                  ...old,
                  ...body.events.filter(
                    (e) => !old.some((row) => row.id === e.id),
                  ),
                ]
              : body.events,
          );
          setCursor(body.nextCursor);
          setHead(body.revision);
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Warmup history unavailable.',
          );
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [id, revision],
  );
  useEffect(() => () => pending.current?.abort(), []);
  function refresh(after: string | null) {
    setBusy(true);
    setError('');
    void read(after);
  }
  return (
    <div>
      <Button
        variant="outline"
        aria-expanded={open}
        aria-label={`History for warmup ${name}`}
        onClick={() => {
          setOpen(!open);
          if (!open) refresh(null);
          else {
            pending.current?.abort();
            setBusy(false);
          }
        }}
      >
        {open ? 'Hide plan history' : 'Plan history'}
      </Button>
      {open && (
        <section aria-label="Warmup plan history">
          <p>
            Saved configuration revisions. These are not scheduled runs, swaps
            or trade receipts. Earlier changes before history storage are not
            reconstructed.
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => refresh(null)}
          >
            Reload plan history
          </Button>
          {head > revision && (
            <output>
              Newer changes exist. Reload warmup plans before editing.
            </output>
          )}
          {error && <p role="alert">{error}</p>}
          {busy && <output>Loading warmup history…</output>}
          {!busy && !error && !events.length && <p>No recorded revisions.</p>}
          <ol className="warmup-history imported-history">
            {events.map((event) => (
              <li key={event.id}>
                <strong>
                  {labels[event.type]} · revision {event.revision}
                </strong>
                <p>{new Date(event.createdAt).toLocaleString()}</p>
                <details>
                  <summary>Configuration at revision {event.revision}</summary>
                  <p>
                    {event.document.name} · {event.document.chain} ·{' '}
                    {event.document.addresses.length} wallets ·{' '}
                    {event.document.cycles} cycles.
                  </p>
                  <p>
                    Buy amount: {event.document.amount}
                    {event.document.amountMax
                      ? ` to ${event.document.amountMax} (range)`
                      : ''}
                    . Fee reserve per wallet: {event.document.feeReserve}. Total
                    budget: {event.document.totalBudget}.
                  </p>
                  <p>
                    Start: {new Date(event.document.startAt).toLocaleString()}.
                    Delay:{' '}
                    {formatWarmupDelay(warmupDelaySeconds(event.document))}.
                  </p>
                  <p className="warmup-address">
                    Tokens: {event.document.tokens.join(', ')}
                  </p>
                  {event.document.walletRevisions.map((w) => (
                    <p key={w.address} className="warmup-address">
                      {w.address} · captured wallet revision {w.revision}
                    </p>
                  ))}
                </details>
              </li>
            ))}
          </ol>
          {cursor && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => refresh(cursor)}
            >
              Load older warmup changes
            </Button>
          )}
        </section>
      )}
    </div>
  );
}
