'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import { importedHolderSummary } from '@/lib/imported-holder-summary';
import { formatNativeBalance } from '@/lib/wallet-balance-format';
import { percentOfSupply } from '@/lib/supply-analysis';
import { subscribeImportedReceiptSaved } from '@/lib/imported-receipt-events';
import { MAX_WATCHED_WALLETS } from '@/lib/supply-watch-wallet';
export function ImportedHolderView({
  project,
  excludedWallets,
  autoLoad = false,
  watchedWallets = [],
  pendingWatchWallets = [],
  onWatch,
}: {
  project: ImportedTokenProject;
  excludedWallets: string[];
  autoLoad?: boolean;
  watchedWallets?: string[];
  pendingWatchWallets?: string[];
  onWatch?: (owner: string) => void | Promise<void>;
}) {
  // Saves still in flight count toward the cap, matching the tracker's guard.
  const watchlistFull =
    new Set([...watchedWallets, ...pendingWatchWallets]).size >=
    MAX_WATCHED_WALLETS;
  const [result, setResult] = useState<ReturnType<
      typeof importedHolderSummary
    > | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(
    () =>
      subscribeImportedReceiptSaved(
        { projectId: project.id, mint: project.document.token.address },
        () => {
          pending.current?.abort();
          pending.current = null;
          setResult(null);
          setBusy(false);
          setError('');
          setNotice(
            'A trade finalized. Refresh sampled holders to review current supply.',
          );
        },
      ),
    [project.id, project.document.token.address],
  );
  const excludedKey = JSON.stringify(excludedWallets);
  const read = useCallback(async () => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const response = await fetch('/api/supply/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mint: project.document.token.address,
          bundleWallets: JSON.parse(excludedKey),
        }),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(45000),
        ]),
      });
      // Gateway errors may return HTML; never surface parser text.
      const value = await response.json().catch(() => null);
      const responseError = (value as { error?: unknown } | null)?.error;
      if (!response.ok)
        throw new Error(
          typeof responseError === 'string'
            ? responseError
            : 'Sampled holder read unavailable.',
        );
      const summary = importedHolderSummary(
        value,
        project.document.token.address,
        project.document.token.decimals,
        JSON.parse(excludedKey),
      );
      if (!controller.signal.aborted && pending.current === controller) {
        setResult(summary);
        setNotice('');
      }
    } catch (e) {
      if (!controller.signal.aborted && pending.current === controller)
        setError(
          e instanceof Error ? e.message : 'Sampled holder read unavailable.',
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }, [
    project.document.token.address,
    project.document.token.decimals,
    excludedKey,
  ]);
  useEffect(() => {
    if (!autoLoad || project.archived || excludedWallets.length > 12) return;
    const timer = setTimeout(() => void read(), 0);
    return () => {
      clearTimeout(timer);
      pending.current?.abort();
    };
  }, [autoLoad, project.archived, excludedWallets.length, read]);
  return (
    <section
      className="imported-holder-view"
      aria-label="Sampled token holders"
    >
      <h4>Holders</h4>
      <p>
        Largest token accounts grouped by wallet owner. This sample does not
        cover all holders or all accounts owned by a wallet.
      </p>
      {autoLoad && (
        <p className="text-xs text-muted-foreground">
          Read on opening this watchlist. Refresh for a new observation.
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={busy || excludedWallets.length > 12}
        onClick={() => void read()}
      >
        {busy ? 'Reading sampled holders…' : 'Refresh sampled holders'}
      </Button>
      <p className="text-xs text-muted-foreground">
        {excludedWallets.length} selected team wallets excluded. Change
        classifications in the supply watchlist to choose exclusions. Reads use
        your Solana RPC.
      </p>
      {excludedWallets.length > 12 && (
        <p>Choose at most 12 team wallets for this read.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <output>{notice}</output>}
      {result && (
        <>
          <p>
            Observed {new Date(result.observedAt).toLocaleString()} · confirmed
            slot {result.slot}. Total supply{' '}
            {formatNativeBalance(result.totalSupplyRaw, result.decimals)}{' '}
            {project.document.token.symbol}.
          </p>
          {onWatch && (
            <p className="text-xs text-muted-foreground">
              Watching saves the public address to your wallet roster as a
              watch-only Recipient. It does not prove ownership or signing
              ability.
              {watchlistFull &&
                ` Your watchlist is full (${MAX_WATCHED_WALLETS} wallets). Remove one in Manage supply watchlist to watch another.`}
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="project-table">
              <caption>
                Sampled largest owners, selected team wallets excluded
              </caption>
              <thead>
                <tr>
                  <th>Owner</th>
                  <th>Sampled token units</th>
                  <th>Total supply share</th>
                  {onWatch && <th>Movement alerts</th>}
                </tr>
              </thead>
              <tbody>
                {result.holders.map((holder) => (
                  <tr key={holder.owner}>
                    <td>
                      <a
                        href={`https://solscan.io/account/${holder.owner}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={holder.owner}
                      >
                        {holder.owner.slice(0, 6)}…{holder.owner.slice(-6)}
                      </a>
                    </td>
                    <td>{formatNativeBalance(holder.raw, result.decimals)}</td>
                    <td>
                      {percentOfSupply(
                        BigInt(holder.raw),
                        BigInt(result.totalSupplyRaw),
                      ).toFixed(3)}
                      %
                    </td>
                    {onWatch && (
                      <td>
                        <Button
                          type="button"
                          variant="outline"
                          aria-label={`Watch holder ${holder.owner}`}
                          disabled={
                            watchedWallets.includes(holder.owner) ||
                            pendingWatchWallets.includes(holder.owner) ||
                            watchlistFull ||
                            project.archived
                          }
                          onClick={() => void onWatch(holder.owner)}
                        >
                          {watchedWallets.includes(holder.owner)
                            ? 'Watching'
                            : pendingWatchWallets.includes(holder.owner)
                              ? 'Saving…'
                              : 'Watch wallet'}
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!result.holders.length && (
            <p>
              No sampled owners remain after exclusions. This does not establish
              that the token has no other holders.
            </p>
          )}
        </>
      )}
    </section>
  );
}
