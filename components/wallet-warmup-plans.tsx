'use client';
import { readPanelJson } from './read-panel-json';
import { ImportedPreparationHistory } from './imported-preparation-history';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { WarmupPlan } from '@/lib/wallet-warmup';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import { WalletWarmupHistoryRuns } from '@/components/wallet-warmup-history-runs';
import { WalletWarmupPreflight } from '@/components/wallet-warmup-preflight';
import { WalletWarmupQuote } from '@/components/wallet-warmup-quote';
import { WarmupBuyReceiptHistory } from './warmup-buy-receipts';
import { WarmupSellReceipts } from './warmup-sell-receipts';
import { WarmupCycleWorkflow } from './warmup-cycle-workflow';
import { WarmupApprovalHistory } from './warmup-approval-history';
import { WalletWarmupPlanHistory } from '@/components/wallet-warmup-plan-history';
export function WalletWarmupPlans({
  chain,
  addresses,
  walletRevisions,
  plan,
  onLoad,
  initialPlan,
}: {
  chain: string;
  addresses: string[];
  walletRevisions: Array<{ address: string; revision: number }>;
  plan: WarmupPlan | null;
  onLoad: (document: SavedWarmup['document']) => void;
  initialPlan?: SavedWarmup;
}) {
  const fieldId = useId();
  const [name, setName] = useState(
    initialPlan?.document.name ?? 'Wallet warmup',
  );
  const [saved, setSaved] = useState<SavedWarmup[]>([]);
  const [selected, setSelected] = useState<SavedWarmup | null>(
    initialPlan ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  async function read(signal: AbortSignal) {
    const response = await fetch('/api/wallet-workspace/warmup/plans', {
      cache: 'no-store',
      signal,
    });
    const data = (await readPanelJson(
      response,
      'Warmup plans unavailable.',
    )) as {
      plans?: SavedWarmup[];
      error?: string;
    } | null;
    if (!data || !response.ok || !Array.isArray(data.plans))
      throw new Error(
        typeof data?.error === 'string' && data.error
          ? data.error
          : 'Warmup plans unavailable.',
      );
    if (!signal.aborted) setSaved(data.plans);
    return data.plans;
  }
  useEffect(() => {
    const c = new AbortController();
    controller.current = c;
    fetch('/api/wallet-workspace/warmup/plans', {
      cache: 'no-store',
      signal: c.signal,
    })
      .then(async (response) => {
        const data = (await readPanelJson(
          response,
          'Warmup plans unavailable.',
        )) as {
          plans?: SavedWarmup[];
          error?: string;
        } | null;
        if (!data || !response.ok || !Array.isArray(data.plans))
          throw new Error(
            typeof data?.error === 'string' && data.error
              ? data.error
              : 'Warmup plans unavailable.',
          );
        if (!c.signal.aborted) setSaved(data.plans);
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Warmup plans unavailable.',
          );
      });
    return () => controller.current?.abort();
  }, []);
  async function mutate(
    action: 'save' | 'archive' | 'restore',
    target: SavedWarmup | null = selected,
  ) {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    setNotice('');
    setError('');
    try {
      if (action === 'save' && !plan)
        throw new Error('Review the current plan before saving.');
      const id = target?.id ?? crypto.randomUUID(),
        expectedRevision = target?.revision ?? 0;
      const response = await fetch('/api/wallet-workspace/warmup/plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: c.signal,
        body: JSON.stringify({
          id,
          expectedRevision,
          action,
          document:
            action === 'save' && plan
              ? {
                  name,
                  chain,
                  addresses: plan.addresses,
                  tokens: plan.tokens,
                  amount: plan.buyAmount,
                  feeReserve: plan.feeReserve,
                  cycles: plan.cycles,
                  intervalMinutes: plan.intervalMinutes,
                  startAt: plan.startAt,
                  walletRevisions,
                }
              : undefined,
        }),
      });
      const data = (await readPanelJson(response, 'Warmup save failed.')) as {
        error?: string;
      } | null;
      if (!response.ok)
        throw new Error(
          typeof data?.error === 'string' && data.error
            ? data.error
            : 'Warmup save failed.',
        );
      const plans = await read(c.signal);
      if (!c.signal.aborted) {
        if (action === 'save')
          setSelected(plans.find((p) => p.id === id) ?? null);
        else if (selected?.id === id) setSelected(null);
        setNotice(
          action === 'save'
            ? 'Warmup plan saved. No swaps scheduled.'
            : action === 'archive'
              ? 'Warmup plan archived.'
              : 'Warmup plan restored.',
        );
      }
    } catch (e) {
      if (!c.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Warmup storage unavailable.',
        );
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  async function reload() {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    setError('');
    try {
      await read(c.signal);
      if (!c.signal.aborted) {
        setSelected(null);
        setNotice('Saved plans reloaded. Reopen a plan before saving changes.');
      }
    } catch (e) {
      if (!c.signal.aborted)
        setError(e instanceof Error ? e.message : 'Warmup plans unavailable.');
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="Saved warmup plans">
      <h4>Saved warmup plans</h4>
      <p>
        Save the public configuration. Reopen and review a future start before
        saving changes. No swaps are scheduled.
      </p>
      <label htmlFor={fieldId}>Warmup plan name</label>
      <Input
        id={fieldId}
        maxLength={80}
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="wallet-roster-actions">
        <Button
          disabled={busy || !plan || Boolean(selected?.archived)}
          onClick={() => mutate('save')}
        >
          {selected ? 'Save warmup changes' : 'Save warmup draft'}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setSelected(null);
            setName('Wallet warmup');
            setNotice('Saving will create a new plan.');
          }}
        >
          New saved warmup
        </Button>
        <Button variant="outline" disabled={busy} onClick={reload}>
          Reload warmup plans
        </Button>
      </div>
      <small>
        {selected ? `Editing r${selected.revision}` : 'New saved draft'} ·{' '}
        {saved.length}/100 saved
      </small>
      {saved
        .filter((p) => p.document.chain === chain)
        .map((p) => {
          const matches =
            p.document.addresses.length === addresses.length &&
            p.document.addresses.every((a) => addresses.includes(a));
          return (
            <article key={p.id} className="warmup-saved-row">
              <strong>{p.document.name}</strong>
              <small>
                {p.document.addresses.length} wallets · {p.document.cycles}{' '}
                cycles · r{p.revision} · {p.archived ? 'Archived' : 'Draft'}
              </small>
              <div className="wallet-roster-actions">
                <Button
                  variant="outline"
                  disabled={busy || p.archived || !matches}
                  onClick={() => {
                    setSelected(p);
                    setName(p.document.name);
                    onLoad(p.document);
                    setNotice(
                      'Configuration reopened. Review it before saving or exporting.',
                    );
                    setError('');
                  }}
                  aria-label={`Open warmup ${p.document.name}`}
                >
                  Open
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => mutate(p.archived ? 'restore' : 'archive', p)}
                  aria-label={`${p.archived ? 'Restore' : 'Archive'} warmup ${p.document.name}`}
                >
                  {p.archived ? 'Restore' : 'Archive'}
                </Button>
              </div>
              {matches && !p.archived && (
                <WalletWarmupPreflight
                  key={p.id + ':' + p.revision}
                  id={p.id}
                  revision={p.revision}
                />
              )}
              {matches && !p.archived && chain === 'Solana' && (
                <WalletWarmupQuote
                  key={'quote:' + p.id + ':' + p.revision}
                  id={p.id}
                  revision={p.revision}
                  cycles={p.document.cycles}
                />
              )}
              <WalletWarmupHistoryRuns
                key={'runs:' + p.id + ':' + p.revision}
                plan={p}
              />
              {p.document.chain === 'Solana' && (
                <WarmupCycleWorkflow
                  key={'progress:' + p.id + ':' + p.revision}
                  plan={p}
                  canReview={matches}
                />
              )}
              {p.document.chain === 'Solana' && (
                <WarmupBuyReceiptHistory
                  key={'buy-receipts:' + p.id + ':' + p.revision}
                  plan={p}
                />
              )}
              {p.document.chain === 'Solana' && (
                <WarmupApprovalHistory
                  key={'approvals:' + p.id + ':' + p.revision}
                  plan={p}
                />
              )}
              {p.document.chain === 'Solana' && (
                <WarmupSellReceipts
                  key={'sell-receipts:' + p.id + ':' + p.revision}
                  planId={p.id}
                />
              )}
              <WalletWarmupPlanHistory
                key={'history:' + p.id + ':' + p.revision}
                id={p.id}
                revision={p.revision}
                name={p.document.name}
              />
              {p.document.chain === 'Solana' && (
                <ImportedPreparationHistory
                  scope="warmup"
                  id={p.id}
                  revision={p.revision}
                />
              )}
              {!matches && (
                <small>
                  Select this plan&apos;s {p.document.addresses.length} wallets
                  to reopen it.
                </small>
              )}
            </article>
          );
        })}
      {notice && <output>{notice}</output>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
