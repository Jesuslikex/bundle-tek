'use client';
import { useCallback, useId, useRef, useState } from 'react';
import { Button } from './ui/button';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import {
  MAX_WATCHED_WALLETS,
  persistWatchedWallet,
} from '@/lib/supply-watch-wallet';
import { SavedSupplyMonitor } from './saved-supply-monitor';
import { ImportedHolderView } from './imported-holder-view';
import type { SupplyScope } from '@/lib/supply-scope';
import {
  SUPPLY_GROUPS,
  supplyTrackerHandoff,
  supplyTrackerWallets,
  type SupplyGroup,
} from '@/lib/supply-tracker-handoff';

export function ImportedSupplyTracker({
  project,
  onOpenChart,
}: {
  project: ImportedTokenProject;
  onOpenChart?: () => void;
}) {
  const [wallets, setWallets] = useState<WorkspaceWallet[]>([]);
  const [groups, setGroups] = useState<Record<string, SupplyGroup>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const panelId = useId();
  const [view, setView] = useState<'holders' | 'alerts'>('holders');
  const [ready, setReady] = useState(false);
  const [watchNotice, setWatchNotice] = useState('');
  const [watchError, setWatchError] = useState('');
  const [watchPending, setWatchPending] = useState<string[]>([]);
  const watching = useRef(new Set<string>());
  // Persist to the wallet roster before selecting; the selection only follows a saved record.
  const watch = async (owner: string) => {
    if (
      project.archived ||
      chosen.length + watching.current.size >= MAX_WATCHED_WALLETS ||
      chosen.some((w) => w.address === owner) ||
      watching.current.has(owner)
    )
      return;
    watching.current.add(owner);
    setWatchPending([...watching.current]);
    setWatchError('');
    setWatchNotice('');
    try {
      const saved = await persistWatchedWallet(project, owner);
      setWallets((old) => [
        ...old.filter((w) => w.address !== saved.address),
        saved,
      ]);
      setGroups((old) => ({ ...old, [saved.address]: 'external' }));
      setWatchNotice(
        'Saved this public address to your wallet roster as a watch-only Recipient. It does not prove ownership or signing ability. Save a baseline, then start movement alerts.',
      );
      setView('alerts');
    } catch (e) {
      setWatchError(
        e instanceof Error ? e.message : 'Cannot watch this wallet.',
      );
    } finally {
      watching.current.delete(owner);
      setWatchPending([...watching.current]);
    }
  };
  const supported = ['Solana', 'Robinhood'].includes(
    project.document.token.chain,
  );
  const chosen = wallets
    .filter((w) => Object.hasOwn(groups, w.address))
    .map((w) => ({
      address: w.address,
      label: w.label,
      group: groups[w.address],
    }));
  const restore = useCallback((scope: SupplyScope) => {
    setGroups(
      Object.fromEntries(scope.wallets.map((w) => [w.address, w.group])),
    );
    setWallets((old) => {
      const known = new Map(old.map((w) => [w.address, w]));
      return scope.wallets.map(
        (w) =>
          known.get(w.address) ?? {
            chain: 'Solana',
            address: w.address,
            label: w.address.slice(0, 8),
            folderId: '',
            role: 'Recipient',
            archived: false,
            revision: 1,
            updatedAt: '',
          },
      );
    });
  }, []);
  let link = '',
    linkError = '';
  if (chosen.length) {
    try {
      link = supplyTrackerHandoff(project, chosen);
    } catch (e) {
      linkError =
        e instanceof Error ? e.message : 'Cannot create tracker link.';
    }
  }
  async function load() {
    const current = ++sequence.current;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/wallet-workspace', {
        cache: 'no-store',
      });
      const data = (await response.json()) as {
        wallets?: WorkspaceWallet[];
        error?: string;
      };
      if (!response.ok || !Array.isArray(data.wallets))
        throw new Error(data.error || 'Cannot load wallet roster.');
      if (sequence.current === current)
        setWallets((old) => {
          const merged = new Map(old.map((w) => [w.address, w]));
          for (const wallet of supplyTrackerWallets(project, data.wallets!))
            merged.set(wallet.address, wallet);
          return [...merged.values()];
        });
    } catch (e) {
      if (sequence.current === current)
        setError(e instanceof Error ? e.message : 'Cannot load wallet roster.');
    } finally {
      if (sequence.current === current) setBusy(false);
    }
  }
  return (
    <section
      className="wallet-warmup-panel"
      aria-label="SupplyTracker integration"
    >
      <div className="token-monitor-heading">
        <h3>Holders and wallet movements</h3>
        {onOpenChart && (
          <Button variant="outline" onClick={onOpenChart}>
            Open chart
          </Button>
        )}
      </div>
      <p>
        Inspect live sampled holders and follow a classified wallet watchlist.
        Wallet roles do not establish team ownership.
      </p>
      {!supported ? (
        <p>The hosted tracker currently supports Solana and Robinhood Chain.</p>
      ) : (
        <>
          <div
            className="token-monitor-navigation"
            aria-label="Token data views"
          >
            <Button
              variant="outline"
              aria-pressed={view === 'holders'}
              aria-controls={`${panelId}-holders`}
              onClick={() => setView('holders')}
            >
              Holders
            </Button>
            <Button
              variant="outline"
              aria-pressed={view === 'alerts'}
              aria-controls={`${panelId}-alerts`}
              onClick={() => setView('alerts')}
            >
              Wallet alerts · {chosen.length} watched
            </Button>
          </div>
          {watchNotice && <output>{watchNotice}</output>}
          {watchError && <p role="alert">{watchError}</p>}
          <details className="supply-wallet-editor">
            <summary>
              Manage supply watchlist ({chosen.length} selected)
            </summary>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void load()}
            >
              {busy ? 'Loading wallets…' : 'Load wallets for supply tracking'}
            </Button>
            <div className="warmup-history">
              {wallets.map((w) => (
                <article key={w.address}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={busy}
                      style={{ width: 'auto', display: 'inline-block' }}
                      checked={Object.hasOwn(groups, w.address)}
                      onChange={(e) =>
                        setGroups((old) => {
                          const next = { ...old };
                          if (e.target.checked) next[w.address] = 'external';
                          else delete next[w.address];
                          return next;
                        })
                      }
                    />{' '}
                    {w.label || 'Wallet'}{' '}
                    <code className="warmup-address">{w.address}</code>
                  </label>
                  {Object.hasOwn(groups, w.address) && (
                    <label>
                      Supply classification for {w.label || w.address}
                      <select
                        disabled={busy}
                        value={groups[w.address]}
                        onChange={(e) =>
                          setGroups((old) => ({
                            ...old,
                            [w.address]: e.target.value as SupplyGroup,
                          }))
                        }
                      >
                        {SUPPLY_GROUPS.map((g) => (
                          <option key={g} value={g}>
                            {g === 'team'
                              ? 'Team controlled'
                              : g === 'pool'
                                ? 'Pool'
                                : 'External'}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </article>
              ))}
            </div>
            <p>
              {chosen.length} selected ·{' '}
              {chosen.filter((w) => w.group === 'team').length} team controlled.
              Opening the tracker shares the token, public addresses, labels,
              and classifications with your hosted SupplyTracker through its
              URL.
            </p>
            {link && (
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                Open selected scope in SupplyTracker
              </a>
            )}
          </details>
          {project.document.token.chain === 'Solana' && (
            <div id={`${panelId}-holders`} hidden={view !== 'holders'}>
              <ImportedHolderView
                key={`${project.id}:${project.revision}:${chosen
                  .filter((w) => w.group === 'team')
                  .map((w) => w.address)
                  .toSorted()
                  .join(',')}`}
                project={project}
                autoLoad={ready}
                watchedWallets={chosen.map((w) => w.address)}
                pendingWatchWallets={watchPending}
                onWatch={watch}
                excludedWallets={chosen
                  .filter((w) => w.group === 'team')
                  .map((w) => w.address)
                  .toSorted()}
              />
            </div>
          )}
          {project.document.token.chain === 'Solana' && (
            <div id={`${panelId}-alerts`} hidden={view !== 'alerts'}>
              <SavedSupplyMonitor
                project={project}
                selected={chosen.map(({ address, group }) => ({
                  address,
                  group,
                }))}
                onRestore={restore}
                onReady={() => setReady(true)}
              />
            </div>
          )}
          <p>
            The tracker reads balances and holder data. Browser monitoring needs
            its page open; Telegram monitoring uses its separately configured
            shared project. Transfers alone do not prove buys or sells.
          </p>
        </>
      )}
      {(error || linkError) && <p role="alert">{error || linkError}</p>}
    </section>
  );
}
