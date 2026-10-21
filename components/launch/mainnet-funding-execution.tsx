'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import type { SavedFunding } from '@/lib/funding-plan';
import { fundingLegs, mainnetFundingAsset } from '@/lib/mainnet-funding';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import { NativeWithdrawalPanel } from '../native-withdrawal-panel';
import { Button } from '../ui/button';
import { readBoundedPanelJson } from '@/lib/read-bounded-panel-json';
import {
  mainnetFundingSource,
  FUNDING_SOURCE_UNAVAILABLE,
  FUNDING_SOURCE_RECHECK_UNAVAILABLE,
} from '@/lib/mainnet-funding-source';

export function MainnetFundingExecution({
  plan,
  enabled,
}: {
  plan: SavedFunding;
  enabled: boolean;
}) {
  return (
    <FundingSourceContent
      key={JSON.stringify([
        plan.id,
        plan.revision,
        plan.updatedAt,
        plan.archived,
        plan.document,
      ])}
      plan={plan}
      enabled={enabled}
    />
  );
}
function FundingSourceContent({
  plan,
  enabled,
}: {
  plan: SavedFunding;
  enabled: boolean;
}) {
  const [wallets, setWallets] = useState<WorkspaceWallet[] | null>(null);
  const [item, setItem] = useState(1);
  const [leg, setLeg] = useState(1);
  const proxies = plan.document.items[item - 1]?.proxies;
  let legs: ReturnType<typeof fundingLegs> = [];
  try {
    legs = fundingLegs(plan.document, item);
  } catch {
    /* Unsupported drafts withhold transfer controls. */
  }
  const sourceWallet = legs[(proxies ? leg : 1) - 1]?.wallet ?? '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [readEnabled, setReadEnabled] = useState(enabled);
  // Clear metadata in the same render as disabling, while retaining item/leg selection.
  if (readEnabled !== enabled) {
    setReadEnabled(enabled);
    setWallets(null);
    setBusy(false);
    setError('');
    setNotice('');
  }
  const pending = useRef<{
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const loadButton = useRef<HTMLButtonElement>(null),
    cancelButton = useRef<HTMLButtonElement>(null);
  let asset: ReturnType<typeof mainnetFundingAsset> | undefined;
  try {
    asset = mainnetFundingAsset(plan.document);
  } catch {
    /* Unsupported profiles withhold transfer controls. */
  }
  const finishFocus = () => {
    if (document.activeElement === cancelButton.current)
      loadButton.current?.focus();
  };
  useLayoutEffect(() => {
    return () => {
      pending.current?.controller.abort();
      if (pending.current) clearTimeout(pending.current.timer);
      pending.current = null;
    };
  }, [enabled]);
  function stop(message: string) {
    const operation = pending.current;
    if (!operation) return;
    finishFocus();
    operation.controller.abort();
    clearTimeout(operation.timer);
    pending.current = null;
    setBusy(false);
    setError(message);
  }
  async function load() {
    if (pending.current || !enabled || plan.archived || !asset || !sourceWallet)
      return;
    const controller = new AbortController();
    const operation = {
      controller,
      timer: setTimeout(() => {
        if (pending.current === operation)
          stop(
            'Source loading timed out. Load the saved source again; nothing was transferred.',
          );
      }, 10000),
    };
    pending.current = operation;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/wallet-workspace', {
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error(
          response.status === 401 || response.status === 403
            ? 'Sign in again before loading the saved funding source.'
            : FUNDING_SOURCE_UNAVAILABLE,
        );
      }
      const body = await readBoundedPanelJson(response, controller.signal);
      let source: WorkspaceWallet[];
      try {
        source = mainnetFundingSource(body, sourceWallet);
      } catch {
        if (
          wallets &&
          !controller.signal.aborted &&
          pending.current === operation
        ) {
          setError(FUNDING_SOURCE_RECHECK_UNAVAILABLE);
          return;
        }
        throw new Error(FUNDING_SOURCE_UNAVAILABLE);
      }
      if (!controller.signal.aborted && pending.current === operation) {
        if (wallets) {
          if (JSON.stringify(source) !== JSON.stringify(wallets)) {
            setError(FUNDING_SOURCE_RECHECK_UNAVAILABLE);
          } else setNotice('Saved source details still match the open review.');
        } else setWallets(source);
      }
    } catch (error) {
      if (!controller.signal.aborted && pending.current === operation)
        setError(
          error instanceof Error &&
            error.message ===
              'Sign in again before loading the saved funding source.'
            ? error.message
            : FUNDING_SOURCE_UNAVAILABLE,
        );
    } finally {
      clearTimeout(operation.timer);
      if (pending.current === operation) {
        finishFocus();
        pending.current = null;
        setBusy(false);
      }
      controller.abort();
    }
  }
  return (
    <section
      aria-label="Mainnet saved funding execution"
      className="min-w-0 space-y-3 break-words rounded-md border p-3"
    >
      <h4>Mainnet Solana funding</h4>
      <p>
        Review one saved recipient at a time. The server checks the saved
        revision, exact transfer terms and due time. Completed recipients cannot
        be sent again in this revision. No background transfer runs here.
      </p>
      {!asset ? (
        <p>
          Select an exact supported Solana token mint or native SOL before
          funding.
        </p>
      ) : !sourceWallet ? (
        <p>
          The saved funding route is unavailable. Reload the saved plan and
          choose a valid recipient and leg before loading its source.
        </p>
      ) : !enabled || plan.archived ? (
        <p>Save the current active draft before preparing mainnet transfers.</p>
      ) : (
        <>
          <p>
            Load saved public-wallet details only. Transfers still require a
            separate review and approval.
          </p>
          {wallets && (
            <p>
              Rechecking keeps the open transfer review intact. Recover any
              pending transfer before changing the recipient or route.
            </p>
          )}
          <p>
            Source wallet: <code>{sourceWallet}</code>. Save or restore this
            exact active wallet in My wallets if it is missing.
          </p>
          <Button
            ref={loadButton}
            variant="outline"
            aria-disabled={busy}
            className="min-h-11 aria-disabled:opacity-50"
            onClick={() => void load()}
          >
            {busy
              ? 'Reading saved source…'
              : wallets
                ? 'Recheck saved source'
                : proxies
                  ? `Load leg ${leg} source wallet`
                  : 'Load saved mainnet funder'}
          </Button>
          {busy && (
            <Button
              ref={cancelButton}
              variant="outline"
              className="min-h-11"
              onClick={() =>
                stop(
                  'Source loading cancelled. Load the saved source again when ready; nothing was transferred.',
                )
              }
            >
              Cancel source loading
            </Button>
          )}
          <p>
            <output>
              {busy
                ? 'Reading saved public-wallet details…'
                : wallets
                  ? 'Saved source loaded. Review this exact transfer below.'
                  : 'Source not loaded.'}
            </output>
          </p>
          <label>
            Saved recipient
            <select
              className="w-full min-w-0"
              value={item}
              disabled={busy}
              onChange={(e) => {
                setItem(Number(e.target.value));
                setLeg(1);
                setWallets(null);
                setError('');
                setNotice('');
              }}
            >
              {plan.document.items.map((entry, i) => (
                <option key={entry.address} value={i + 1}>
                  {i + 1}. {entry.address} · {entry.amount} {asset.symbol} · due{' '}
                  {entry.scheduledAt}
                  {entry.proxies ? ` · via ${entry.proxies.length} proxy` : ''}
                </option>
              ))}
            </select>
          </label>
          {proxies && (
            <label>
              Proxy leg
              <select
                className="w-full min-w-0"
                value={leg}
                disabled={busy}
                onChange={(e) => {
                  setLeg(Number(e.target.value));
                  setWallets(null);
                  setError('');
                  setNotice('');
                }}
              >
                {legs.map((l, i) => (
                  <option key={l.wallet} value={i + 1}>
                    Leg {i + 1}: {l.wallet} → {l.recipient}
                  </option>
                ))}
              </select>
              <small>
                Send legs in order. A leg unlocks only after the previous one
                finalizes. Earlier legs carry 0.0001 SOL per remaining hop so
                each proxy can pay its own fee; any unused part stays in the
                proxy.
              </small>
            </label>
          )}
          {wallets && (
            <NativeWithdrawalPanel
              key={`${plan.id}:${plan.revision}:${item}:${leg}`}
              wallets={wallets}
              initialWallet={sourceWallet}
              initialOpen
              initialToken={
                asset.kind === 'token'
                  ? { mint: asset.mint, decimals: asset.decimals }
                  : undefined
              }
              funding={proxies ? { plan, item, leg } : { plan, item }}
            />
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && (
        <p>
          <output>{notice}</output>
        </p>
      )}
    </section>
  );
}
