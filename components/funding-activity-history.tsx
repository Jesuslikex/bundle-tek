'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { SavedFunding } from '@/lib/funding-plan';
import { FundingExecutionHistoryPanel } from '@/components/launch/funding-execution-history';

export function FundingActivityHistory({
  id,
  eventName,
  refreshRevision,
  onClose,
}: {
  id: string;
  eventName: string;
  refreshRevision: number;
  onClose: () => void;
}) {
  const [reload, setReload] = useState(0);
  const identity = `${id}/${refreshRevision}/${reload}`;
  const [state, setState] = useState<{
    identity: string;
    plan: SavedFunding | null;
    error: string;
  }>({ identity: '', plan: null, error: '' });
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [id]);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `/api/funding?id=${encodeURIComponent(id)}`,
          {
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        const data = (await response.json()) as {
          plan?: SavedFunding;
          error?: string;
        };
        if (!response.ok)
          throw new Error(data.error || 'Funding draft unavailable.');
        const plan = data.plan;
        if (
          !plan ||
          plan.id !== id ||
          !Number.isSafeInteger(plan.revision) ||
          plan.revision < 1 ||
          typeof plan.archived !== 'boolean' ||
          typeof plan.document?.name !== 'string' ||
          typeof plan.document?.total !== 'string' ||
          !Array.isArray(plan.document.recipients)
        )
          throw new Error('Funding draft response mismatch.');
        if (!controller.signal.aborted) setState({ identity, plan, error: '' });
      } catch (error) {
        if (!controller.signal.aborted)
          setState({
            identity,
            plan: null,
            error:
              error instanceof Error
                ? error.message
                : 'Funding draft unavailable.',
          });
      }
    })();
    return () => controller.abort();
  }, [id, identity]);
  const current = state.identity === identity ? state : null;
  return (
    <section
      className="wallet-holdings-panel"
      aria-label="Funding activity details"
    >
      <div className="wallet-roster-toolbar">
        <h2 tabIndex={-1} ref={heading}>
          Funding history · {eventName}
        </h2>
        <Button variant="outline" onClick={onClose}>
          Close funding history
        </Button>
      </div>
      <p className="source-note">
        The latest saved draft is shown. Its name, settings and revision may
        differ from this historical event. Only verified receipts establish
        delivery.
      </p>
      {!current ? (
        <output>Loading saved funding draft…</output>
      ) : current.error ? (
        <>
          <p role="alert">{current.error}</p>
          <Button
            variant="outline"
            onClick={() => setReload((value) => value + 1)}
          >
            Retry funding history
          </Button>
        </>
      ) : (
        current.plan && (
          <>
            <p>
              {current.plan.document.name} · {current.plan.document.chain} ·{' '}
              revision {current.plan.revision} ·{' '}
              {current.plan.archived ? 'Archived' : 'Active'}
            </p>
            <p>
              Draft total: {current.plan.document.total}{' '}
              {current.plan.document.currency} for{' '}
              {current.plan.document.recipients.length}{' '}
              {current.plan.document.recipients.length === 1
                ? 'recipient'
                : 'recipients'}
              .
            </p>
            <Button
              variant="outline"
              onClick={() => setReload((value) => value + 1)}
            >
              Reload funding draft
            </Button>
            {current.plan.document.chain === 'Solana' ? (
              <FundingExecutionHistoryPanel
                key={`${id}/${current.plan.revision}`}
                id={id}
                revision={current.plan.revision}
                name={current.plan.document.name}
                externalRevision={refreshRevision + reload}
              />
            ) : (
              <p>
                Execution receipt history for {current.plan.document.chain} is
                not available.
              </p>
            )}
          </>
        )
      )}
    </section>
  );
}
