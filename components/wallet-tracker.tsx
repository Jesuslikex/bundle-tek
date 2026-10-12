'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArrowUpRight,
  Crosshair,
  Plus,
  RefreshCw,
  Search,
  WalletCards,
  Pencil,
  Star,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { TrackedWallet, WalletObservation } from '@/lib/tracked-wallet';
import { WALLET_ICONS } from '@/lib/tracked-wallet';
import {
  isSolanaTrackedWallet,
  trackerNetworkLabel,
  type TrackerNetwork,
} from '@/lib/tracked-wallet';
import { EVM_NETWORKS, evmChain } from '@/lib/evm-network';
import { EvmHoldingsPanel } from './evm-holdings-panel';
import { EvmTrackedWallet } from './evm-tracked-wallet';
import { EvmTrackedTransactions } from './evm-tracked-transactions';
import { WalletHoldingsPanel } from './wallet-holdings-panel';
import { TrackedTransactionPanel } from './tracked-transaction-panel';
import { TrackedTransactionHistory } from './tracked-transaction-history';

const key = (wallet: Pick<TrackedWallet, 'address' | 'network'>) =>
  `${wallet.network}:${wallet.address}`;
const short = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-5)}`;

async function readTracker() {
  const response = await fetch('/api/tracker', { cache: 'no-store' });
  const result = (await response.json()) as {
    error?: string;
    wallets?: TrackedWallet[];
  };
  if (!response.ok) throw new Error(result.error || 'Could not load tracker.');
  if (!Array.isArray(result.wallets))
    throw new Error('Invalid tracker response.');
  return result.wallets;
}

export function WalletTracker({ onSupply }: { onSupply: () => void }) {
  const [wallets, setWallets] = useState<TrackedWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [network, setNetwork] = useState<TrackerNetwork>('mainnet');
  const [networkFilter, setNetworkFilter] = useState<TrackerNetwork | 'all'>(
    'all',
  );
  const [editor, setEditor] = useState<'single' | 'bulk' | 'edit' | null>(null);
  const [editing, setEditing] = useState<TrackedWallet | null>(null);
  const [group, setGroup] = useState('');
  const [icon, setIcon] = useState('⭐');
  const [favorite, setFavorite] = useState(false);
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [addresses, setAddresses] = useState('');
  const [label, setLabel] = useState('');
  const [selected, setSelected] = useState<TrackedWallet | null>(null);
  const [holdingsKey, setHoldingsKey] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const transactionSaved = useCallback(
    () => setHistoryRefresh((r) => r + 1),
    [],
  );
  const [transactionChoice, setTransactionChoice] = useState<{
    walletKey: string;
    signature: string;
    saved: boolean;
  } | null>(null);
  const [observation, setObservation] = useState<WalletObservation | null>(
    null,
  );
  const [observing, setObserving] = useState(false);
  const [observationError, setObservationError] = useState('');
  const observationVersion = useRef(0);
  const loadVersion = useRef(0);
  const invalidateRequests = useCallback(() => {
    observationVersion.current++;
    loadVersion.current++;
  }, []);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      const response = await fetch('/api/tracker', { cache: 'no-store' });
      const result = (await response.json()) as {
        error?: string;
        wallets?: TrackedWallet[];
      };
      if (!response.ok)
        throw new Error(result.error || 'Could not load tracker.');
      if (!Array.isArray(result.wallets))
        throw new Error('Invalid tracker response.');
      if (version !== loadVersion.current) return null;
      setError('');
      setLoadFailed(false);
      setWallets(result.wallets);
      setSelected((current) =>
        current
          ? (result.wallets!.find((w) => key(w) === key(current)) ?? null)
          : null,
      );
      return result.wallets as TrackedWallet[];
    } catch (e) {
      if (version === loadVersion.current) {
        setLoadFailed(true);
        setError(e instanceof Error ? e.message : 'Could not load tracker.');
      }
      return null;
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const version = ++loadVersion.current;
    void readTracker()
      .then((wallets) => {
        if (version === loadVersion.current) {
          setWallets(wallets);
          setError('');
          setLoadFailed(false);
        }
      })
      .catch((error) => {
        if (version === loadVersion.current) {
          setLoadFailed(true);
          setError(
            error instanceof Error ? error.message : 'Could not load tracker.',
          );
        }
      })
      .finally(() => {
        if (version === loadVersion.current) setLoading(false);
      });
    return invalidateRequests;
  }, [invalidateRequests]);

  const mutate = async (body: unknown) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/tracker', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as {
        error?: string;
        added?: number;
      };
      if (!response.ok)
        throw new Error(result.error || 'Could not save tracker.');
      await load();
      setNotice(
        result.added
          ? `${result.added} public address${result.added === 1 ? '' : 'es'} saved.`
          : 'Tracker updated.',
      );
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save tracker.');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const observe = async (wallet: TrackedWallet) => {
    setTransactionChoice(null);
    const version = ++observationVersion.current;
    setSelected(wallet);
    setObservation(null);
    setObservationError('');
    if (!isSolanaTrackedWallet(wallet)) {
      setObserving(false);
      return;
    }
    setObserving(true);
    try {
      const response = await fetch(
        `/api/tracker/observe?${new URLSearchParams({ address: wallet.address, network: wallet.network })}`,
        { cache: 'no-store' },
      );
      const result = (await response.json()) as {
        error?: string;
        observation?: WalletObservation;
      };
      if (version !== observationVersion.current) return;
      if (!response.ok) throw new Error(result.error || 'Observation failed.');
      if (!result.observation) throw new Error('Invalid observation response.');
      setObservation(result.observation);
    } catch (e) {
      if (version === observationVersion.current)
        setObservationError(
          e instanceof Error ? e.message : 'Observation failed.',
        );
    } finally {
      if (version === observationVersion.current) setObserving(false);
    }
  };
  const clearObservation = () => {
    setTransactionChoice(null);
    observationVersion.current++;
    setSelected(null);
    setObservation(null);
    setObserving(false);
    setObservationError('');
  };
  const filtered = wallets
    .filter(
      (w) =>
        w.archived === archived &&
        (networkFilter === 'all' || w.network === networkFilter) &&
        (groupFilter === null || w.group === groupFilter) &&
        (!favoritesOnly || w.favorite) &&
        `${w.label} ${w.address} ${w.network} ${w.group}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => Number(b.favorite) - Number(a.favorite));
  const groups = [...new Set(wallets.map((w) => w.group).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
  function openEditor(
    mode: 'single' | 'bulk' | 'edit',
    wallet?: TrackedWallet,
  ) {
    setEditor(mode);
    setEditing(wallet ?? null);
    setAddresses(wallet?.address ?? '');
    setLabel(wallet?.label ?? '');
    setGroup(wallet?.group ?? '');
    setIcon(wallet?.icon ?? '⭐');
    setFavorite(wallet?.favorite ?? false);
    if (wallet) setNetwork(wallet.network);
  }

  const holdingsWallet = wallets.find(
    (w) => key(w) === holdingsKey && w.network !== 'devnet',
  );
  const transactionWallet = wallets.find(
    (w) => key(w) === transactionChoice?.walletKey,
  );
  const historyWallet = wallets.find((w) => key(w) === historyKey);
  return (
    <section className="project-dashboard wallet-tracker">
      <header className="dashboard-heading">
        <div>
          <span className="eyebrow">PUBLIC ADDRESSES · 6 NETWORKS</span>
          <h1>Wallet tracker</h1>
          <p>Keep a watchlist and inspect on-chain activity on demand.</p>
        </div>
        <div className="tracker-actions">
          <Button variant="outline" onClick={onSupply}>
            Supply analysis
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              openEditor('bulk');
            }}
            disabled={busy}
          >
            Bulk add
          </Button>
          <Button
            onClick={() => {
              openEditor('single');
            }}
            disabled={busy}
          >
            <Plus /> Add wallet
          </Button>
        </div>
      </header>
      <div className="tracker-disclosure">
        <Crosshair size={16} />
        <span>
          Read-only public snapshots. Solana signatures and EVM account nonces
          are not classified trades. No wallet connection is required.
        </span>
      </div>
      <div className="dashboard-stats tracker-stats">
        <article>
          <span>Tracked wallets</span>
          <strong>
            {loading ? '…' : wallets.filter((w) => !w.archived).length}
          </strong>
          <small>Saved to your account</small>
        </article>
        <article>
          <span>Mainnet</span>
          <strong>
            {loading
              ? '…'
              : wallets.filter((w) => !w.archived && w.network !== 'devnet')
                  .length}
          </strong>
          <small>Read-only</small>
        </article>
        <article>
          <span>Devnet</span>
          <strong>
            {loading
              ? '…'
              : wallets.filter((w) => !w.archived && w.network === 'devnet')
                  .length}
          </strong>
          <small>Test network</small>
        </article>
        <article>
          <span>Observation</span>
          <strong>On demand</strong>
          <small>No background monitoring</small>
        </article>
      </div>
      {error && (
        <p role="alert" className="tracker-error">
          {error}
        </p>
      )}
      {notice && <output className="tracker-notice">{notice}</output>}
      {editor && (
        <form
          className="tracker-editor"
          onSubmit={async (e) => {
            e.preventDefault();
            const entries =
              editor === 'bulk'
                ? addresses
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter(Boolean)
                : [addresses.trim()];
            if (
              await mutate(
                editor === 'edit' && editing
                  ? {
                      action: 'edit',
                      address: editing.address,
                      network: editing.network,
                      label,
                      group,
                      icon,
                      favorite,
                      expectedUpdatedAt: editing.updatedAt,
                    }
                  : {
                      action: 'add',
                      wallets: entries.map((address) => ({
                        address,
                        network,
                        label,
                        group,
                        icon,
                        favorite,
                      })),
                    },
              )
            ) {
              setEditor(null);
              setAddresses('');
              setLabel('');
            }
          }}
        >
          <h2>
            {editor === 'bulk'
              ? 'Add public addresses in bulk'
              : editor === 'edit'
                ? 'Edit tracked wallet'
                : 'Add a wallet'}
          </h2>
          <p>
            Solana and supported EVM public addresses. Up to 100 saved
            addresses, including archived entries.
          </p>
          <div className="tracker-editor-fields">
            <label>
              Network
              <select
                aria-label="Tracker network"
                value={network}
                onChange={(e) => setNetwork(e.target.value as TrackerNetwork)}
                disabled={busy || editor === 'edit'}
              >
                <option value="mainnet">Solana mainnet</option>
                <option value="devnet">Solana devnet</option>
                {Object.keys(EVM_NETWORKS).map((chain) => (
                  <option key={chain} value={chain}>
                    {chain} mainnet
                  </option>
                ))}
              </select>
            </label>
            <label>
              {editor === 'bulk'
                ? 'Batch label (optional)'
                : 'Label (optional)'}
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={60}
                disabled={busy}
              />
            </label>
          </div>
          <div className="tracker-editor-fields">
            <label htmlFor="tracker-wallet-group">
              Group (optional)
              <Input
                id="tracker-wallet-group"
                value={group}
                maxLength={40}
                list="tracker-groups"
                onChange={(e) => setGroup(e.target.value)}
                disabled={busy}
              />
            </label>
            <datalist id="tracker-groups">
              {groups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </datalist>
            <label>
              Wallet icon
              <select
                aria-label="Wallet icon"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                disabled={busy}
              >
                {WALLET_ICONS.map((i) => (
                  <option key={i} value={i}>
                    {i}
                  </option>
                ))}
              </select>
            </label>
            <label className="tracker-favorite-control">
              <input
                type="checkbox"
                checked={favorite}
                onChange={(e) => setFavorite(e.target.checked)}
                disabled={busy}
              />{' '}
              Favorite wallet
            </label>
          </div>
          <label>
            {editor === 'bulk'
              ? 'One public address per line'
              : 'Public address'}
            {editor === 'bulk' ? (
              <textarea
                aria-label="Public addresses"
                rows={5}
                value={addresses}
                onChange={(e) => setAddresses(e.target.value)}
                required
                disabled={busy}
              />
            ) : (
              <Input
                aria-label="Public address"
                value={addresses}
                onChange={(e) => setAddresses(e.target.value)}
                required
                disabled={busy || editor === 'edit'}
              />
            )}
          </label>
          <div className="tracker-actions">
            <Button type="submit" disabled={busy}>
              {busy
                ? 'Saving…'
                : editor === 'edit'
                  ? 'Save wallet changes'
                  : 'Save to tracker'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setEditor(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      <div className="project-toolbar">
        <div className="tracker-tabs" aria-label="Tracker views">
          <button
            aria-pressed={!archived}
            onClick={() => {
              setArchived(false);
              clearObservation();
            }}
          >
            Active
          </button>
          <button
            aria-pressed={archived}
            onClick={() => {
              setArchived(true);
              clearObservation();
            }}
          >
            Archived
          </button>
        </div>
        <select
          aria-label="Filter wallet group"
          value={groupFilter === null ? 'all' : JSON.stringify(groupFilter)}
          onChange={(e) =>
            setGroupFilter(
              e.target.value === 'all' ? null : JSON.parse(e.target.value),
            )
          }
        >
          <option value="all">All groups</option>
          <option value={'""'}>Ungrouped</option>
          {groups.map((g) => (
            <option key={g} value={JSON.stringify(g)}>
              {g}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter tracker network"
          value={networkFilter}
          onChange={(event) =>
            setNetworkFilter(event.target.value as TrackerNetwork | 'all')
          }
        >
          <option value="all">All networks</option>
          <option value="mainnet">Solana mainnet</option>
          <option value="devnet">Solana devnet</option>
          {Object.keys(EVM_NETWORKS).map((chain) => (
            <option key={chain} value={chain}>
              {chain} mainnet
            </option>
          ))}
        </select>
        <Button
          variant="outline"
          aria-pressed={favoritesOnly}
          onClick={() => setFavoritesOnly(!favoritesOnly)}
        >
          <Star /> Favorites
        </Button>
        <div className="project-search">
          <Search />
          <Input
            aria-label="Search tracked wallets"
            placeholder="Search label or address…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button
          variant="outline"
          aria-label="Reload tracker"
          onClick={() => {
            setLoading(true);
            void load();
          }}
          disabled={loading || busy}
        >
          <RefreshCw />
        </Button>
      </div>
      <div className="tracker-grid">
        <div className="project-table-wrap">
          <table className="project-table">
            <thead>
              <tr>
                <th>Wallet</th>
                <th>Network</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((w) => (
                <tr
                  key={key(w)}
                  className={
                    selected && key(selected) === key(w)
                      ? 'tracker-selected'
                      : ''
                  }
                >
                  <td>
                    <strong>
                      <span aria-hidden="true">{w.icon}</span>{' '}
                      {w.label || 'Unlabelled wallet'}
                    </strong>
                    {w.group && <span className="wallet-group">{w.group}</span>}
                    <span title={w.address} className="wallet-address">
                      {short(w.address)}
                    </span>
                  </td>
                  <td>
                    <span className="draft-badge">
                      {trackerNetworkLabel(w.network)}
                    </span>
                  </td>
                  <td>
                    <div className="project-row-actions">
                      <Button
                        variant="ghost"
                        disabled={busy}
                        aria-label={`Edit ${w.label || w.address}`}
                        onClick={() => openEditor('edit', w)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        aria-label={`${w.favorite ? 'Unfavorite' : 'Favorite'} ${w.label || w.address}`}
                        aria-pressed={w.favorite}
                        onClick={() =>
                          void mutate({
                            action: 'edit',
                            ...w,
                            favorite: !w.favorite,
                            expectedUpdatedAt: w.updatedAt,
                          })
                        }
                      >
                        <Star fill={w.favorite ? 'currentColor' : 'none'} />
                      </Button>
                      {isSolanaTrackedWallet(w) && (
                        <Button
                          variant="ghost"
                          disabled={busy || loadFailed}
                          aria-label={`Transaction history for ${w.label || w.address}`}
                          onClick={() => {
                            setHistoryKey(key(w));
                            setTransactionChoice(null);
                          }}
                        >
                          History
                        </Button>
                      )}
                      {w.network !== 'devnet' && (
                        <Button
                          variant="ghost"
                          disabled={busy || loadFailed}
                          aria-label={`Token holdings for ${w.label || w.address}`}
                          onClick={() => setHoldingsKey(key(w))}
                        >
                          Tokens
                        </Button>
                      )}
                      {(!archived || !isSolanaTrackedWallet(w)) && (
                        <Button
                          variant="ghost"
                          onClick={() => void observe(w)}
                          disabled={busy}
                          aria-label={`Inspect ${w.label || w.address}`}
                        >
                          <Crosshair />{' '}
                          {isSolanaTrackedWallet(w) ? 'Inspect' : 'Snapshot'}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        disabled={busy}
                        aria-label={`${archived ? 'Restore' : 'Archive'} ${w.label || w.address}`}
                        onClick={async () => {
                          if (
                            await mutate({
                              action: archived ? 'restore' : 'archive',
                              ...w,
                              expectedUpdatedAt: w.updatedAt,
                            })
                          )
                            clearObservation();
                        }}
                      >
                        {archived ? <RefreshCw /> : <Archive />}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && (
            <div className="project-empty">
              <WalletCards />
              <h2>
                {loading
                  ? 'Loading tracker…'
                  : loadFailed
                    ? 'Tracker unavailable'
                    : search ||
                        favoritesOnly ||
                        groupFilter !== null ||
                        networkFilter !== 'all'
                      ? 'No matching wallets'
                      : archived
                        ? 'No archived wallets'
                        : 'No wallets tracked yet'}
              </h2>
              <p>
                {search ||
                favoritesOnly ||
                groupFilter !== null ||
                networkFilter !== 'all'
                  ? 'Try another network or group, turn off Favorites or clear the search.'
                  : archived
                    ? 'Archived addresses can be restored here.'
                    : 'Add a public address to inspect its balance and recent signature records.'}
              </p>
            </div>
          )}
        </div>
        <aside className="wallet-observation">
          <h2>{selected?.label || 'Wallet observation'}</h2>
          {selected ? (
            <>
              <p className="wallet-address full-address">{selected.address}</p>
              <span className="draft-badge">
                {trackerNetworkLabel(selected.network)}
              </span>
              {!isSolanaTrackedWallet(selected) ? (
                <EvmTrackedWallet
                  key={`${key(selected)}:${selected.updatedAt}`}
                  wallet={selected}
                />
              ) : (
                <>
                  <Button
                    variant="outline"
                    disabled={observing}
                    onClick={() => void observe(selected)}
                  >
                    <RefreshCw />{' '}
                    {observing ? 'Reading chain…' : 'Refresh snapshot'}
                  </Button>
                  {observationError && (
                    <p role="alert" className="tracker-error">
                      {observationError}
                    </p>
                  )}
                  {observation && (
                    <>
                      <div className="observed-balance">
                        <small>Observed balance</small>
                        <strong>
                          {observation.balanceSol.toLocaleString(undefined, {
                            maximumFractionDigits: 9,
                          })}{' '}
                          <span>SOL</span>
                        </strong>
                        <small>
                          Slot {observation.slot.toLocaleString()} ·{' '}
                          {new Date(
                            observation.observedAt,
                          ).toLocaleTimeString()}
                        </small>
                      </div>
                      <h3>Latest signatures</h3>
                      {!observation.signatures.length && (
                        <p>No recent signature records returned.</p>
                      )}
                      <ul className="signature-list">
                        {observation.signatures.map((s) => (
                          <li key={s.signature}>
                            <a
                              href={`https://explorer.solana.com/tx/${s.signature}${selected.network === 'devnet' ? '?cluster=devnet' : ''}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {short(s.signature)} <ArrowUpRight size={13} />
                            </a>
                            <span>
                              {s.failed ? 'Failed' : 'Confirmed record'}
                            </span>
                            <Button
                              variant="ghost"
                              disabled={busy || loadFailed}
                              aria-label={`Transaction details ${s.signature}`}
                              onClick={() =>
                                setTransactionChoice({
                                  walletKey: key(selected),
                                  signature: s.signature,
                                  saved: false,
                                })
                              }
                            >
                              Details
                            </Button>
                            <small>
                              {s.blockTime === null
                                ? `Slot ${s.slot}`
                                : new Date(s.blockTime * 1000).toLocaleString()}
                            </small>
                          </li>
                        ))}
                      </ul>
                      <p className="observation-limit">
                        Latest 12 records only. Open Details to inspect recorded
                        balance changes. A signature alone does not establish a
                        trade.
                      </p>
                    </>
                  )}
                </>
              )}
            </>
          ) : (
            <div className="observation-empty">
              <Crosshair />
              <p>
                Select Inspect or Snapshot beside a wallet to review public
                observations.
              </p>
            </div>
          )}
        </aside>
      </div>
      {selected && !isSolanaTrackedWallet(selected) && (
        <EvmTrackedTransactions
          key={`transactions:${key(selected)}:${selected.updatedAt}`}
          wallet={selected}
        />
      )}
      {historyWallet && (
        <TrackedTransactionHistory
          key={`${key(historyWallet)}:${historyWallet.updatedAt}`}
          wallet={historyWallet}
          refreshVersion={historyRefresh}
          onClose={() => setHistoryKey(null)}
          onOpen={(signature, saved) =>
            setTransactionChoice({
              walletKey: key(historyWallet),
              signature,
              saved,
            })
          }
        />
      )}
      {transactionChoice && transactionWallet && (
        <TrackedTransactionPanel
          key={`${key(transactionWallet)}:${transactionWallet.updatedAt}:${transactionChoice.signature}:${transactionChoice.saved}`}
          wallet={transactionWallet}
          signature={transactionChoice.signature}
          saved={transactionChoice.saved}
          onSaved={transactionSaved}
          onClose={() => setTransactionChoice(null)}
        />
      )}
      {holdingsWallet &&
        (isSolanaTrackedWallet(holdingsWallet) ? (
          <WalletHoldingsPanel
            key={`${key(holdingsWallet)}:${holdingsWallet.updatedAt}`}
            address={holdingsWallet.address}
            label={holdingsWallet.label}
            active={!holdingsWallet.archived && !loadFailed}
            trackerUpdatedAt={holdingsWallet.updatedAt}
            onClose={() => setHoldingsKey(null)}
          />
        ) : (
          <EvmHoldingsPanel
            key={`${key(holdingsWallet)}:${holdingsWallet.updatedAt}`}
            chain={evmChain(holdingsWallet.network)}
            address={holdingsWallet.address}
            label={holdingsWallet.label}
            active={!holdingsWallet.archived && !loadFailed}
            trackerUpdatedAt={holdingsWallet.updatedAt}
            onClose={() => setHoldingsKey(null)}
          />
        ))}
    </section>
  );
}
