'use client';
import { useEffect, useRef, useState } from 'react';
import type { SavedFunding } from '@/lib/funding-plan';
import { mainnetFundingAsset } from '@/lib/mainnet-funding';
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
          w.address === plan.document.funderAddress &&
          !w.archived &&
          Number.isSafeInteger(w.revision) &&
          w.revision > 0,
      );
      if (source.length !== 1)
        throw new Error(
          'Save this exact active Solana funder in the wallet workspace first.',
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
            {busy ? 'Reading saved funder…' : 'Load saved mainnet funder'}
          </Button>
          <label>
            Saved recipient
            <select
              className="w-full min-w-0"
              value={item}
              disabled={busy}
              onChange={(e) => setItem(Number(e.target.value))}
            >
              {plan.document.items.map((entry, i) => (
                <option key={entry.address} value={i + 1}>
                  {i + 1}. {entry.address} · {entry.amount} {asset.symbol} · due{' '}
                  {entry.scheduledAt}
                </option>
              ))}
            </select>
          </label>
          {wallets && (
            <NativeWithdrawalPanel
              key={`${plan.id}:${plan.revision}:${item}`}
              wallets={wallets}
              initialWallet={plan.document.funderAddress}
              initialOpen
              initialToken={
                asset.kind === 'token'
                  ? { mint: asset.mint, decimals: asset.decimals }
                  : undefined
              }
              funding={{ plan, item }}
            />
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
