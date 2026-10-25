'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { SavedFunding } from '@/lib/funding-plan';
import { FundingExecutionHistoryPanel } from '@/components/launch/funding-execution-history';
import { MainnetFundingHistoryPanel } from '@/components/launch/mainnet-funding-history';
import { readBoundedPanelJson } from '@/lib/read-bounded-panel-json';

const unavailable =
  'Funding draft unavailable. Retry funding history to try again.';
class FundingDraftError extends Error {}

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
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new FundingDraftError(
            response.status === 401
              ? 'Sign in again before loading funding history.'
              : response.status === 403 || response.status === 404
                ? 'This saved funding draft is unavailable to your account.'
                : response.status === 429
                  ? 'Funding history is rate limited. Wait before retrying.'
                  : unavailable,
          );
        }
        const data = (await readBoundedPanelJson(
          response,
          controller.signal,
        )) as {
          plan?: SavedFunding;
        } | null;
        const plan = data?.plan;
        if (
          !plan ||
          plan.id !== id ||
          !Number.isSafeInteger(plan.revision) ||
          plan.revision < 1 ||
          typeof plan.archived !== 'boolean' ||
          typeof plan.document?.name !== 'string' ||
          typeof plan.document?.chain !== 'string' ||
          typeof plan.document?.currency !== 'string' ||
          typeof plan.document?.total !== 'string' ||
          !Array.isArray(plan.document.recipients)
        )
          throw new FundingDraftError('Funding draft response mismatch.');
        if (!controller.signal.aborted) setState({ identity, plan, error: '' });
      } catch (error) {
        if (!controller.signal.aborted)
          setState({
            identity,
            plan: null,
            error:
              error instanceof FundingDraftError ? error.message : unavailable,
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
              <div key={identity}>
                <h3>Mainnet</h3>
                <p>
                  Open saved mainnet attempts and verified receipts separately
                  from devnet test history. Opening history does not send or
                  verify a transaction.
                </p>
                <MainnetFundingHistoryPanel
                  id={id}
                  revision={current.plan.revision}
                  name={current.plan.document.name}
                />
                <h3>Devnet test history</h3>
                <FundingExecutionHistoryPanel
                  id={id}
                  revision={current.plan.revision}
                  name={current.plan.document.name}
                  externalRevision={refreshRevision + reload}
                />
              </div>
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
