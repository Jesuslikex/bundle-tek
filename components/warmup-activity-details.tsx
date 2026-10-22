'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { WarmupHistoryRunTimeline } from '@/components/warmup-history-run-timeline';
import { WalletWarmupPlanHistory } from '@/components/wallet-warmup-plan-history';
import { WarmupApprovalHistory } from '@/components/warmup-approval-history';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import { readSavedWarmupDisplay } from '@/lib/warmup-saved-plan-display';
import { readBoundedPanelJson } from '@/lib/read-bounded-panel-json';
import { nativeUnits } from '@/lib/wallet-warmup';
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
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [id]);
  useEffect(() => {
    const controller = new AbortController();
    pending.current = controller;
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) {
      void Promise.resolve().then(() => {
        if (!controller.signal.aborted)
          setState({
            identity,
            plan: null,
            error: 'Choose a saved warmup plan.',
          });
      });
      return () => controller.abort();
    }
    const timeout = setTimeout(() => {
      if (controller.signal.aborted) return;
      controller.abort();
      setState({
        identity,
        plan: null,
        error:
          'Loading saved warmup took too long. Check your connection and reload.',
      });
    }, 30_000);
    let failure = 'Saved warmup unavailable. Reload to try again.';
    fetch(`/api/wallet-workspace/warmup/plans?id=${encodeURIComponent(id)}`, {
      cache: 'no-store',
      signal: controller.signal,
      redirect: 'error',
    })
      .then(async (response) => {
        if (!response.ok) {
          failure =
            response.status === 401
              ? 'Sign in again, then reload this saved warmup.'
              : response.status === 404
                ? 'This saved warmup is no longer available. Open My wallets to choose a plan.'
                : response.status === 429
                  ? 'Too many requests. Wait a moment, then reload saved warmup.'
                  : 'Saved warmup unavailable. Reload to try again.';
          void response.body?.cancel().catch(() => {});
          throw new Error();
        }
        const data = await readBoundedPanelJson(response, controller.signal);
        failure =
          'Saved warmup details do not match this plan. Reload to try again.';
        const plan = readSavedWarmupDisplay(data, id);
        if (!controller.signal.aborted) setState({ identity, plan, error: '' });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState({ identity, plan: null, error: failure });
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [id, identity]);
  const current = state.identity === identity ? state : null;
  let currency = 'native units';
  if (current?.plan) {
    try {
      currency = nativeUnits(current.plan.document.chain).symbol;
    } catch {
      // A historical network may no longer be supported for new plans.
    }
  }
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
      <Button
        variant="outline"
        disabled={!current}
        onClick={() => setReload((v) => v + 1)}
      >
        Reload saved warmup
      </Button>
      {!current ? (
        <>
          <output>
            Loading saved warmup… No wallet unlock or transaction is requested.
          </output>
          <Button
            variant="ghost"
            onClick={() => {
              pending.current?.abort();
              setState({
                identity,
                plan: null,
                error: 'Saved warmup read cancelled. Reload when ready.',
              });
            }}
          >
            Cancel saved warmup read
          </Button>
        </>
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
              Buy amount: {current.plan.document.amount}
              {current.plan.document.amountMax
                ? ` to ${current.plan.document.amountMax} (range)`
                : ''}{' '}
              {currency}. Total budget: {current.plan.document.totalBudget}{' '}
              {currency}. Fee reserve per wallet:{' '}
              {current.plan.document.feeReserve} {currency}.
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
                  viewOnly
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
