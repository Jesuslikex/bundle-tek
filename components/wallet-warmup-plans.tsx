'use client';
import styles from './wallet-warmup.module.css';
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
type PendingSave = {
  id: string;
  revision: number;
  document: SavedWarmup['document'];
};
function matchesPendingSave(saved: SavedWarmup, pending: PendingSave) {
  const a = saved.document,
    b = pending.document;
  return (
    saved.id === pending.id &&
    saved.revision === pending.revision &&
    !saved.archived &&
    a.name === b.name &&
    a.chain === b.chain &&
    a.amount === b.amount &&
    a.amountMax === b.amountMax &&
    JSON.stringify(a.amounts) === JSON.stringify(b.amounts) &&
    a.feeReserve === b.feeReserve &&
    a.cycles === b.cycles &&
    a.intervalMinutes === b.intervalMinutes &&
    a.intervalSeconds === b.intervalSeconds &&
    a.startAt === b.startAt &&
    a.totalBudget === b.totalBudget &&
    a.addresses.length === b.addresses.length &&
    a.addresses.every((address, i) => address === b.addresses[i]) &&
    a.tokens.length === b.tokens.length &&
    a.tokens.every((token, i) => token === b.tokens[i]) &&
    a.walletRevisions.length === b.walletRevisions.length &&
    a.walletRevisions.every(
      (wallet, i) =>
        wallet.address === b.walletRevisions[i].address &&
        wallet.revision === b.walletRevisions[i].revision,
    )
  );
}
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
  onLoad: (document: SavedWarmup['document'], freshStart?: boolean) => void;
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
  const [busy, setBusy] = useState(true);
  const [saveUnconfirmed, setSaveUnconfirmed] = useState(false);
  const [mustReopen, setMustReopen] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftId = useRef<string | null>(null);
  const pendingSave = useRef<PendingSave | null>(null);
  function beginRequest() {
    controller.current?.abort();
    if (timer.current) clearTimeout(timer.current);
    const c = new AbortController();
    controller.current = c;
    timer.current = setTimeout(() => {
      if (controller.current !== c || c.signal.aborted) return;
      c.abort();
      setBusy(false);
      setError(
        'Plan request took too long. Reload saved plans to check whether a save completed, then try again.',
      );
    }, 30000);
    return c;
  }
  function finishRequest(c: AbortController) {
    if (controller.current !== c) return;
    if (timer.current) clearTimeout(timer.current);
    if (!c.signal.aborted) setBusy(false);
  }
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
    const c = beginRequest();
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
      })
      .finally(() => finishRequest(c));
    return () => {
      controller.current?.abort();
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  async function mutate(
    action: 'save' | 'archive' | 'restore',
    target: SavedWarmup | null = selected,
  ) {
    const c = beginRequest();
    setBusy(true);
    setNotice('');
    setError('');
    try {
      if (action === 'save' && !plan)
        throw new Error('Review the current plan before saving.');
      if (action === 'save' && mustReopen)
        throw new Error('Reopen the latest draft before saving changes.');
      if (action === 'save' && plan && Date.parse(plan.startAt) < Date.now())
        throw new Error(
          'Reviewed start time has passed. Choose a fresh start time and review the warmup plan again.',
        );
      if (!target && !draftId.current) draftId.current = crypto.randomUUID();
      const id = target?.id ?? draftId.current!,
        expectedRevision = target?.revision ?? 0;
      const document =
        action === 'save' && plan
          ? {
              name: name.trim(),
              chain,
              addresses: plan.addresses,
              tokens: plan.tokens,
              amount: plan.buyAmount,
              ...(plan.buyAmountMax
                ? { amountMax: plan.buyAmountMax, amounts: plan.buyAmounts }
                : {}),
              feeReserve: plan.feeReserve,
              cycles: plan.cycles,
              // Non-default routing and the reviewed organic draws are part of
              // the terms, so a saved plan rebuilds to the same schedule.
              ...(plan.platform === 'none' ? {} : { platform: plan.platform }),
              ...(plan.schedule === 'staggered'
                ? {}
                : { schedule: plan.schedule }),
              ...(plan.organic && plan.organicTerms
                ? { organic: plan.organic, organicTerms: plan.organicTerms }
                : {}),
              ...(plan.intervalMinutes === undefined
                ? { intervalSeconds: plan.intervalSeconds }
                : { intervalMinutes: plan.intervalMinutes }),
              startAt: plan.startAt,
              walletRevisions,
              totalBudget: plan.totalBudget,
            }
          : undefined;
      const body = JSON.stringify({
        id,
        expectedRevision,
        action,
        document: document
          ? { ...document, name, totalBudget: undefined }
          : undefined,
      });
      const pending = document
        ? { id, revision: expectedRevision + 1, document }
        : null;
      if (pending) {
        pendingSave.current = pending;
        setSaveUnconfirmed(true);
      }
      const response = await fetch('/api/wallet-workspace/warmup/plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: c.signal,
        body,
      });
      const data = (await readPanelJson(response, 'Warmup save failed.')) as {
        error?: string;
      } | null;
      if (c.signal.aborted) return;
      if (!response.ok)
        throw new Error(
          typeof data?.error === 'string' && data.error
            ? data.error
            : 'Warmup save failed.',
        );
      const plans = await read(c.signal);
      if (!c.signal.aborted) {
        if (action === 'save') {
          const confirmed = plans.find((p) => p.id === id);
          if (
            !pending ||
            !confirmed ||
            !matchesPendingSave(confirmed, pending)
          ) {
            setMustReopen(
              Boolean(
                confirmed && pending && confirmed.revision >= pending.revision,
              ),
            );
            throw new Error(
              'The saved draft does not match this review yet. Your edits are kept. Reload drafts to check the outcome before retrying.',
            );
          }
          setSelected(confirmed);
          pendingSave.current = null;
          setSaveUnconfirmed(false);
        } else if (selected?.id === id) {
          setSelected(null);
          setMustReopen(false);
        }
        if (action !== 'save' && pendingSave.current?.id === id) {
          pendingSave.current = null;
          setSaveUnconfirmed(false);
        }
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
      finishRequest(c);
    }
  }
  async function reload() {
    const c = beginRequest();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const plans = await read(c.signal);
      if (!c.signal.aborted) {
        const pending = pendingSave.current;
        const recovered = plans.find((p) => p.id === pending?.id);
        if (pending && recovered && matchesPendingSave(recovered, pending)) {
          setSelected(recovered);
          pendingSave.current = null;
          setSaveUnconfirmed(false);
          setMustReopen(false);
          setNotice(
            'Saved draft found. Your current edits are kept. Use Edit draft to reopen its saved settings.',
          );
        } else if (pending) {
          setMustReopen(
            Boolean(recovered && recovered.revision >= pending.revision),
          );
          setError(
            recovered && recovered.revision >= pending.revision
              ? recovered.archived
                ? 'The saved draft is archived. Your edits are kept. Restore it under Draft details, or choose New draft for a separate copy.'
                : 'A different saved version was found. Your edits are kept. Reopen the saved draft to review it, or choose New draft for a separate copy.'
              : 'This reload has not confirmed your save. Your edits are kept. Reload again to check; retrying keeps the same draft identity.',
          );
        } else if (selected) {
          const latest = plans.find((p) => p.id === selected.id);
          const changed =
            !latest ||
            latest.revision !== selected.revision ||
            latest.archived !== selected.archived;
          setMustReopen(changed);
          setNotice(
            changed
              ? 'This saved draft changed or is unavailable. Your edits are kept. Reopen the latest draft, or choose New draft to save a separate copy.'
              : 'Draft list refreshed. Your current edits are kept.',
          );
        } else {
          setNotice('Saved plans reloaded. Your current draft is kept.');
        }
      }
    } catch (e) {
      if (!c.signal.aborted)
        setError(e instanceof Error ? e.message : 'Warmup plans unavailable.');
    } finally {
      finishRequest(c);
    }
  }
  return (
    <section className={styles.saved} aria-label="Saved warmup plans">
      <h4>3. Review and save</h4>
      <p>Save a draft to return to it later. No trades are scheduled.</p>
      <label htmlFor={fieldId}>Warmup plan name</label>
      <Input
        id={fieldId}
        maxLength={80}
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
      />
      <div className={styles.saveActions}>
        <Button
          disabled={busy || !plan || mustReopen || Boolean(selected?.archived)}
          onClick={() => mutate('save')}
        >
          {selected ? 'Save changes' : 'Save draft'}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setSelected(null);
            draftId.current = null;
            pendingSave.current = null;
            setSaveUnconfirmed(false);
            setMustReopen(false);
            setName('Wallet warmup');
            setError('');
            setNotice('Saving will create a new plan.');
          }}
        >
          New draft
        </Button>
        <Button variant="outline" disabled={busy} onClick={reload}>
          Reload drafts
        </Button>
      </div>
      {busy && (
        <div>
          <output>
            Reading or saving a public draft. No transactions are started.
          </output>
          <Button
            variant="ghost"
            onClick={() => {
              controller.current?.abort();
              if (timer.current) clearTimeout(timer.current);
              setBusy(false);
              setError(
                'Plan request cancelled. Reload saved plans to check whether a save completed.',
              );
            }}
          >
            Cancel plan request
          </Button>
        </div>
      )}
      <small>
        {selected ? 'Editing draft' : 'New saved draft'} · {saved.length}/100
        saved
      </small>
      {!plan && <p>Review your draft above to enable Save.</p>}
      {error && saveUnconfirmed && !busy && (
        <p>
          {mustReopen
            ? 'The save was not confirmed. Review the saved version or choose a separate new draft.'
            : 'The save was not confirmed. Reload saved plans before retrying. Retrying this draft keeps the same identity.'}
        </p>
      )}
      {notice && <output>{notice}</output>}
      {error && <p role="alert">{error}</p>}
      {selected?.archived && (
        <p>
          This saved plan is archived. Restore it before saving changes or
          preparing a new transaction.
        </p>
      )}
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
                cycles · {p.archived ? 'Archived' : 'Draft'}
              </small>
              <div className={styles.savedActions}>
                <Button
                  variant="outline"
                  disabled={busy || p.archived || !matches}
                  onClick={() => {
                    setSelected(p);
                    pendingSave.current = null;
                    setSaveUnconfirmed(false);
                    setMustReopen(false);
                    setName(p.document.name);
                    onLoad(p.document);
                    setNotice(
                      'Configuration reopened. Review it before saving or exporting.',
                    );
                    setError('');
                  }}
                  aria-label={`Open warmup ${p.document.name}`}
                >
                  Edit draft
                </Button>
                {!p.archived && matches && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setSelected(p);
                      pendingSave.current = null;
                      setSaveUnconfirmed(false);
                      setMustReopen(false);
                      setName(p.document.name);
                      onLoad(p.document, true);
                      setNotice(
                        'Fresh start selected. Review the complete plan and save changes; nothing is scheduled.',
                      );
                      setError('');
                    }}
                  >
                    Review with fresh start
                  </Button>
                )}
              </div>
              <details className={styles.technical}>
                <summary>Draft details</summary>
                <p>Saved revision {p.revision}</p>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => mutate(p.archived ? 'restore' : 'archive', p)}
                  aria-label={`${p.archived ? 'Restore' : 'Archive'} warmup ${p.document.name}`}
                >
                  {p.archived ? 'Restore' : 'Archive'}
                </Button>
              </details>
              {matches && !p.archived && (
                <WalletWarmupPreflight
                  key={p.id + ':' + p.revision}
                  id={p.id}
                  revision={p.revision}
                />
              )}
              {matches && !p.archived && chain === 'Solana' && (
                <details className={styles.technical}>
                  <summary>Optional market quote</summary>
                  <WalletWarmupQuote
                    key={'quote:' + p.id + ':' + p.revision}
                    id={p.id}
                    revision={p.revision}
                    cycles={p.document.cycles}
                  />
                </details>
              )}
              <details className={styles.advanced}>
                <summary>Transactions and recovery</summary>
                <p>
                  Advanced controls for explicit transaction reviews and past
                  activity. Nothing runs automatically.
                </p>
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
              </details>
              {!matches && (
                <small>
                  Select this plan&apos;s {p.document.addresses.length} wallets
                  to reopen it.
                </small>
              )}
            </article>
          );
        })}
    </section>
  );
}
