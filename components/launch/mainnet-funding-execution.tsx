'use client';
import { useEffect, useRef, useState } from 'react';
import type { SavedFunding } from '@/lib/funding-plan';
import { fundingLegs, mainnetFundingAsset } from '@/lib/mainnet-funding';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import { NativeWithdrawalPanel } from '../native-withdrawal-panel';
import { Button } from '../ui/button';

export function MainnetFundingExecution({
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
  const pending = useRef<AbortController | null>(null);
  let asset: ReturnType<typeof mainnetFundingAsset> | undefined;
  try {
    asset = mainnetFundingAsset(plan.document);
  } catch {
    /* Unsupported profiles withhold transfer controls. */
  }
  useEffect(() => () => pending.current?.abort(), []);
  async function load() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setWallets(null);
    try {
      const response = await fetch('/api/wallet-workspace', {
        cache: 'no-store',
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(10000),
        ]),
      });
      const value = (await response.json()) as {
        wallets?: WorkspaceWallet[];
        error?: string;
      };
      if (
        !response.ok ||
        !Array.isArray(value.wallets) ||
        value.wallets.length > 500
      )
        throw new Error(value.error || 'Saved funding source unavailable.');
      const source = value.wallets.filter(
        (w) =>
          w.chain === 'Solana' &&
          w.address === sourceWallet &&
          !w.archived &&
          Number.isSafeInteger(w.revision) &&
          w.revision > 0,
      );
      if (source.length !== 1)
        throw new Error(
          'Save this exact active Solana source wallet in the wallet workspace first.',
        );
      if (!controller.signal.aborted) setWallets(source);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(
          error instanceof Error ? error.message : 'Saved source unavailable.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
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
      ) : !enabled ? (
        <p>Save the current draft before preparing mainnet transfers.</p>
      ) : (
        <>
          <Button variant="outline" disabled={busy} onClick={() => void load()}>
            {busy
              ? 'Reading saved source…'
              : proxies
                ? `Load leg ${leg} source wallet`
                : 'Load saved mainnet funder'}
          </Button>
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
    </section>
  );
}
