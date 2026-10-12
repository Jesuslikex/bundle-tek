'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { WarmupHistoryRunTimeline } from '@/components/warmup-history-run-timeline';
import { WalletWarmupPlanHistory } from '@/components/wallet-warmup-plan-history';
import { WarmupApprovalHistory } from '@/components/warmup-approval-history';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
export function WarmupActivityDetails({
  id,
  run,
  refreshRevision,
  onClose,
  onOpenWallets,
}: {
  id: string;
  run?: { id: string; revision: number };
  refreshRevision: number;
  onClose: () => void;
  onOpenWallets: (id: string) => void;
}) {
  const [reload, setReload] = useState(0);
  const identity = `${id}/${refreshRevision}/${reload}`;
  const [state, setState] = useState<{
    identity: string;
    plan: SavedWarmup | null;
    error: string;
  }>({ identity: '', plan: null, error: '' });
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [id]);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/wallet-workspace/warmup/plans?id=${encodeURIComponent(id)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = (await response.json()) as {
          plan?: SavedWarmup;
          error?: string;
        };
        if (!response.ok)
          throw new Error(data.error || 'Warmup plan unavailable.');
        const plan = data.plan;
        if (
          !plan ||
          plan.id !== id ||
          !Number.isSafeInteger(plan.revision) ||
          plan.revision < 1 ||
          typeof plan.archived !== 'boolean' ||
          typeof plan.document?.name !== 'string' ||
          !Array.isArray(plan.document.walletRevisions)
        )
          throw new Error('Warmup response mismatch.');
        if (!controller.signal.aborted) setState({ identity, plan, error: '' });
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setState({
            identity,
            plan: null,
            error: e instanceof Error ? e.message : 'Warmup plan unavailable.',
          });
      });
    return () => controller.abort();
  }, [id, identity]);
  const current = state.identity === identity ? state : null;
  return (
    <section
      className="wallet-holdings-panel"
      aria-label="Warmup activity details"
    >
      <div className="wallet-roster-toolbar">
        <h2 tabIndex={-1} ref={heading}>
          Saved warmup details
        </h2>
        <Button variant="outline" onClick={onClose}>
          Close warmup details
        </Button>
      </div>
      <p>
        The latest saved configuration is shown, including archived plans. It
        may differ from the historical event. Public history run links show
        retained transitions separately; no trade is implied.
      </p>
      {run && (
        <>
          <p>
            Selected public history run: {run.id} · event revision{' '}
            {run.revision}. The timeline reads the latest retained transitions
            for this run.
          </p>
          <WarmupHistoryRunTimeline
            key={`${run.id}:${refreshRevision}:${reload}`}
            id={run.id}
            revision={run.revision}
            initiallyOpen
          />
        </>
      )}
      <Button variant="outline" onClick={() => setReload((v) => v + 1)}>
        Reload saved warmup
      </Button>
      {!current ? (
        <output>Loading saved warmup…</output>
      ) : current.error ? (
        <p role="alert">{current.error}</p>
      ) : (
        current.plan && (
          <>
            <h3>{current.plan.document.name}</h3>
            <p>
              {current.plan.document.chain} ·{' '}
              {current.plan.archived ? 'Archived' : 'Draft'} · saved revision{' '}
              {current.plan.revision} · {current.plan.document.cycles} cycles.
            </p>
            <p>
              Buy amount: {current.plan.document.amount}. Total budget:{' '}
              {current.plan.document.totalBudget}. Fee reserve per wallet:{' '}
              {current.plan.document.feeReserve}.
            </p>
            <p className="warmup-address">
              Tokens: {current.plan.document.tokens.join(', ')}
            </p>
            {current.plan.document.walletRevisions.map((w) => (
              <p key={w.address} className="warmup-address">
                {w.address} · captured wallet revision {w.revision}
              </p>
            ))}
            <p>
              Use My wallets to select these addresses and review the saved
              plan. Archived or changed wallets require an updated saved
              configuration.
            </p>
            <Button variant="outline" onClick={() => onOpenWallets(id)}>
              Open warmup in My wallets
            </Button>
            <WalletWarmupPlanHistory
              key={current.plan.id + ':' + current.plan.revision}
              id={current.plan.id}
              revision={current.plan.revision}
              name={current.plan.document.name}
            />
            {current.plan.document.chain === 'Solana' && (
              <>
                <WarmupApprovalHistory
                  key={'approvals:' + identity + ':' + current.plan.revision}
                  plan={current.plan}
                />
              </>
            )}
          </>
        )
      )}
    </section>
  );
}
