'use client';

import { useEffect, useId, useRef, useState } from 'react';

import { Folder, Plus, Download, X } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { Input } from '@/components/ui/input';

import { WalletConsole } from '@/components/wallet-console';

import { WalletHoldingsPanel } from '@/components/wallet-holdings-panel';

import { EvmHoldingsPanel } from '@/components/evm-holdings-panel';

import { WalletFolderDeleteDialog } from '@/components/wallet-folder-delete-dialog';

import { WalletFolderRow } from '@/components/wallet-folder-row';
import { BrowserWalletVault } from '@/components/browser-wallet-vault';
import { WalletWarmup } from '@/components/wallet-warmup';
import { TokenToolsPanel } from './token-tools-panel';
import { NativeWithdrawalPanel } from '@/components/native-withdrawal-panel';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
import { resolveWarmupWorkspace } from '@/lib/warmup-workspace-handoff';

import { WalletFolderEditor } from '@/components/wallet-folder-editor';

import { ArchivedWalletFolders } from '@/components/archived-wallet-folders';

import { EvmWalletConnection } from '@/components/evm-wallet-connection';

import { CHAINS, type LaunchChain } from '@/lib/launch-plan';

import {
  WALLET_ROLES,
  DEFAULT_FOLDER_COLOR,
  walletFolderIds,
  type WalletRole,
  type WalletFolder,
  type WorkspaceWallet,
  type WalletWorkspace as Workspace,
} from '@/lib/wallet-workspace';

import {
  combinedWalletBalance,
  type BalanceSnapshot,
} from '@/lib/wallet-balance-format';

async function readWorkspace(signal?: AbortSignal): Promise<Workspace> {
  const response = await fetch('/api/wallet-workspace', {
    cache: 'no-store',

    signal,
  });

  const data = (await response.json()) as Workspace & { error?: string };

  if (
    !response.ok ||
    !Array.isArray(data.folders) ||
    !Array.isArray(data.wallets)
  )
    throw new Error(data.error || 'Wallet workspace unavailable.');

  return data;
}

export function WalletWorkspace({
  onFunding,
  initialWarmupId = '',
  initialWithdrawalWallet = '',
}: {
  onFunding: () => void;
  initialWarmupId?: string;
  initialWithdrawalWallet?: string;
}) {
  const [data, setData] = useState<Workspace>({ folders: [], wallets: [] });

  const [chain, setChain] = useState<LaunchChain>('Solana');

  const [folder, setFolder] = useState('all');

  const [managing, setManaging] = useState(false);

  const [folderQuery, setFolderQuery] = useState('');

  const [archived, setArchived] = useState(false);

  const [query, setQuery] = useState('');

  const [holdingsAddress, setHoldingsAddress] = useState<string | null>(null);
  const [withdrawalChoice, setWithdrawalChoice] = useState<{
    id: string;
    wallet: string;
    mint: string;
    decimals: number;
  } | null>(null);

  const [selected, setSelected] = useState<string[]>([]);
  const [warmupOpen, setWarmupOpen] = useState(false);
  const [initialWarmup, setInitialWarmup] = useState<SavedWarmup | null>(null);

  const [loading, setLoading] = useState(true);

  const [busy, setBusy] = useState(false);

  const [error, setError] = useState('');

  const [notice, setNotice] = useState('');

  const [deletingFolder, setDeletingFolder] = useState<WalletFolder | null>(
    null,
  );

  const [folderForm, setFolderForm] = useState<WalletFolder | 'new' | null>(
    null,
  );

  const [walletForm, setWalletForm] = useState<WorkspaceWallet | 'new' | null>(
    null,
  );

  const [addresses, setAddresses] = useState('');

  const [label, setLabel] = useState('');
  const [tags, setTags] = useState('');

  const [role, setRole] = useState<WalletRole>('Recipient');

  const [target, setTarget] = useState('');

  const [moveTarget, setMoveTarget] = useState('');

  const folderActionFocus = useRef<HTMLElement | null>(null);
  const rootFolderButton = useRef<HTMLButtonElement>(null);
  const balanceRequest = useRef<AbortController | null>(null);
  const managerControl = useRef<HTMLDivElement>(null);
  const managerButton = useRef<HTMLButtonElement>(null);
  const managerSearch = useRef<HTMLInputElement>(null);
  const managerId = useId();
  useEffect(() => {
    if (!managing) return;
    managerSearch.current?.focus();
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !managerControl.current?.contains(target) &&
        !target.closest('[data-wallet-selection]')
      )
        setManaging(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setManaging(false);
        managerButton.current?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [managing]);

  useEffect(() => {
    const controller = new AbortController();

    void readWorkspace(controller.signal)
      .then(async (value) => {
        if (controller.signal.aborted) return;
        setData(value);
        if (initialWarmupId) {
          const response = await fetch(
            `/api/wallet-workspace/warmup/plans?id=${encodeURIComponent(initialWarmupId)}`,
            { cache: 'no-store', signal: controller.signal },
          );
          const body = (await response.json()) as {
            plan?: SavedWarmup;
            error?: string;
          };
          if (!response.ok || !body.plan || body.plan.id !== initialWarmupId)
            throw new Error(body.error || 'Saved warmup unavailable.');
          const handoff = resolveWarmupWorkspace(body.plan, value);
          if (controller.signal.aborted) return;
          setChain(handoff.chain);
          if (!handoff.canOpen) {
            setNotice(
              `Saved warmup ${body.plan.document.name} cannot reopen because these wallets are missing or archived: ${handoff.unavailable.join(', ')}. No partial selection was applied.`,
            );
            return;
          }
          setSelected(handoff.addresses);
          setInitialWarmup(body.plan);
          setWarmupOpen(true);
          setNotice(
            handoff.changed.length
              ? `Opened ${body.plan.document.name}. These wallet revisions changed: ${handoff.changed.join(', ')}. Recheck and save an updated configuration before preparation.`
              : `Opened saved warmup ${body.plan.document.name} at revision ${body.plan.revision}${body.plan.archived ? ' (archived)' : ''}.`,
          );
        }
      })

      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })

      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => {
      controller.abort();

      balanceRequest.current?.abort();
    };
  }, [initialWarmupId]);

  async function reload() {
    setLoading(true);

    setError('');

    try {
      setData(await readWorkspace());

      setSelected([]);
      setInitialWarmup(null);
      setWarmupOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Workspace unavailable.');
    } finally {
      setLoading(false);
    }
  }

  async function mutate(body: Record<string, unknown>, success: string) {
    setBusy(true);

    setError('');

    setNotice('');

    try {
      const response = await fetch('/api/wallet-workspace', {
        method: 'POST',

        headers: { 'content-type': 'application/json' },

        body: JSON.stringify({ chain, ...body }),
      });

      const result = (await response.json()) as { error?: string };

      if (!response.ok)
        throw new Error(result.error || 'Could not save wallet changes.');

      setData(await readWorkspace());

      if (body.action !== 'wallet.folder-toggle') setSelected([]);

      setFolderForm(null);

      setWalletForm(null);

      setNotice(success);

      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Workspace unavailable.');

      return false;
    } finally {
      setBusy(false);
    }
  }

  const folders = data.folders.filter((f) => f.chain === chain);

  const activeFolders = folders.filter((f) => !f.archived);

  const visibleFolders = archived ? [] : activeFolders;

  const rows = data.wallets.filter(
    (w) =>
      w.chain === chain &&
      (folder === 'all' || walletFolderIds(w).includes(folder)) &&
      (archived ? w.archived : !w.archived) &&
      `${w.label} ${w.address} ${w.role} ${(w.tags ?? []).join(' ')}`

        .toLowerCase()

        .includes(query.toLowerCase()),
  );

  const picks = rows.filter((w) => selected.includes(w.address));

  const balanceTargets = picks.length ? picks : rows;

  const combined = combinedWalletBalance(balanceTargets, data.balances ?? []);

  const balances = new Map(
    (data.balances ?? [])

      .filter((b) => b.chain === chain)

      .map((b) => [b.address, b]),
  );

  const proofs = new Map(
    (data.proofs ?? [])

      .filter((p) => p.chain === chain)

      .map((p) => [p.address, p.verifiedAt]),
  );

  const savedAddresses = data.wallets

    .filter((w) => w.chain === chain && !w.archived)

    .map((w) => w.address);

  async function refreshBalances() {
    const controller = new AbortController();

    balanceRequest.current = controller;

    setBusy(true);

    setError('');

    setNotice('Refreshing native balances…');

    try {
      const response = await fetch('/api/wallet-workspace/balances', {
        method: 'POST',

        headers: { 'content-type': 'application/json' },

        signal: controller.signal,

        body: JSON.stringify({
          chain,

          addresses: balanceTargets.map((w) => w.address),
        }),
      });

      const body = (await response.json()) as {
        snapshot?: BalanceSnapshot;

        error?: string;
      };

      if (!response.ok || !body.snapshot)
        throw new Error(body.error || 'Balances unavailable.');

      if (!controller.signal.aborted) {
        const snapshot = body.snapshot;

        setData((current) => ({
          ...current,

          balances: [
            ...(current.balances ?? []).filter(
              (b) =>
                !snapshot.items.some(
                  (item) =>
                    item.chain === b.chain && item.address === b.address,
                ),
            ),

            ...snapshot.items,
          ],
        }));

        setNotice(
          `Refreshed ${snapshot.items.length} native ${snapshot.items.length === 1 ? 'balance' : 'balances'}. No funds moved.`,
        );
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(
          `${e instanceof Error ? e.message : 'Balances unavailable.'} Previous observations are retained.`,
        );

        setNotice('');
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const currentFolder = folders.find((f) => f.id === folder);

  const resetSelection = () => {
    setSelected([]);

    setWalletForm(null);

    setFolderForm(null);

    setMoveTarget('');
  };

  function editWallet(wallet?: WorkspaceWallet) {
    setWalletForm(wallet ?? 'new');

    setAddresses(wallet?.address ?? '');

    setLabel(wallet?.label ?? '');
    setTags((wallet?.tags ?? []).join(', '));

    setRole(wallet?.role ?? 'Recipient');

    setTarget(
      wallet?.folderId ??
        (activeFolders.some((f) => f.id === folder) ? folder : ''),
    );

    setFolderForm(null);
  }

  function exportPublic() {
    const csv = [
      'chain,address,label,role,tags,folder,native_balance,currency,observed_at',

      ...(picks.length ? picks : rows).map((w) =>
        [
          w.chain,

          w.address,

          w.label,

          w.role,
          (w.tags ?? []).join(' | '),

          folders
            .filter((f) => walletFolderIds(w).includes(f.id))
            .map((f) => f.name)
            .join(' | '),

          balances.get(w.address)?.amount ?? '',

          balances.get(w.address)?.currency ?? '',

          balances.get(w.address)?.observedAt ?? '',
        ]

          .map((value) => `"${value.replaceAll('"', '""')}"`)

          .join(','),
      ),
    ].join('\r\n');

    const url = URL.createObjectURL(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    );

    const link = document.createElement('a');

    link.href = url;

    link.download = `pulseforge-${chain.toLowerCase()}-public-wallets.csv`;

    link.click();

    URL.revokeObjectURL(url);
  }

  const holdingsWallet = data.wallets.find(
    (w) => w.chain === chain && w.address === holdingsAddress,
  );

  return (
    <section className="project-dashboard wallet-workspace">
      <header className="dashboard-heading">
        <div>
          <span className="eyebrow">WALLET WORKSPACE</span>
          <h1>My wallets</h1>
          <p>Organize public addresses by network, folder and launch role.</p>
        </div>
        <Button
          variant="outline"

          disabled={loading || busy}

          onClick={() => void reload()}
        >
          Reload wallets
        </Button>
      </header>
      <p className="wallet-roster-boundary">
        Adding an address does not prove ownership or give signing access.
        Imported addresses use your external wallet. Generated keys stay in your
        encrypted browser vault. Solana swaps and asset withdrawals require
        separate review, vault or connected-wallet approval and submission.
        Mainnet token launches, Token-2022 swaps, transfer-hook withdrawals and
        EVM withdrawals remain unavailable.
      </p>
      <div className="wallet-roster-toolbar">
        <label>
          Wallet network
          <select
            value={chain}

            disabled={busy}

            onChange={(e) => {
              setChain(e.target.value as LaunchChain);

              setFolder('all');

              resetSelection();
            }}
          >
            {CHAINS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"

          disabled={busy}

          aria-pressed={archived}

          onClick={() => {
            setArchived(!archived);

            setFolder('all');

            resetSelection();
          }}
        >
          {archived ? 'Active wallets' : 'Archived wallets'}
        </Button>
        <ArchivedWalletFolders
          key={chain}
          folders={folders}
          wallets={data.wallets.filter((wallet) => wallet.chain === chain)}
          busy={busy}
          loading={loading}
          error={error}
          onRestore={(folder) =>
            mutate(
              {
                action: 'folder.restore',
                id: folder.id,
                revision: folder.revision,
              },
              'Folder restored. Its wallets stay in the parent list.',
            )
          }
        />
        <Input
          aria-label="Search workspace wallets"

          placeholder="Search name, address, role or tag"

          value={query}

          onChange={(e) => {
            setQuery(e.target.value);

            setSelected([]);
          }}
        />
      </div>
      {error && (
        <p role="alert" className="tracker-error">
          {error}
        </p>
      )}
      {notice && <output className="funding-notice">{notice}</output>}
      {deletingFolder && (
        <WalletFolderDeleteDialog
          key={deletingFolder.id}
          folder={deletingFolder}
          returnFocus={folderActionFocus}
          walletCount={
            data.wallets.filter(
              (wallet) =>
                wallet.chain === chain &&
                walletFolderIds(wallet).includes(deletingFolder.id),
            ).length
          }
          busy={busy}
          error={error}
          onClose={() => setDeletingFolder(null)}
          onDelete={async () => {
            const ok = await mutate(
              {
                action: 'folder.delete',
                id: deletingFolder.id,
                revision: deletingFolder.revision,
              },
              'Folder deleted. Its wallets remain saved.',
            );
            if (ok) {
              folderActionFocus.current = rootFolderButton.current;
              setDeletingFolder(null);
              setFolder('all');
              setArchived(false);
            }
          }}
        />
      )}
      {folderForm && (
        <WalletFolderEditor
          key={folderForm === 'new' ? 'new' : folderForm.id}
          folder={folderForm}
          returnFocus={folderActionFocus}
          folders={folders}
          busy={busy}
          error={error}
          onClose={() => setFolderForm(null)}
          onSave={(name, color) =>
            mutate(
              folderForm === 'new'
                ? {
                    action: 'folder.create',
                    id: crypto.randomUUID(),
                    name,
                    color,
                  }
                : {
                    action: 'folder.update',
                    id: folderForm.id,
                    revision: folderForm.revision,
                    name,
                    color,
                  },
              folderForm === 'new' ? 'Folder created.' : 'Folder updated.',
            )
          }
        />
      )}
      <div className="wallet-roster-layout">
        <aside className="wallet-folders" aria-label="Wallet folders">
          <button
            ref={rootFolderButton}
            className={folder === 'all' ? 'selected' : ''}

            disabled={busy}

            onClick={() => {
              setFolder('all');

              resetSelection();
            }}
          >
            <Folder size={16} /> All {archived ? 'archived' : 'active'} wallets{' '}
            <b>
              {
                data.wallets.filter(
                  (w) =>
                    w.chain === chain && (archived ? w.archived : !w.archived),
                ).length
              }
            </b>
          </button>
          {visibleFolders.map((f) => (
            <WalletFolderRow
              key={f.id}
              folder={f}
              count={
                data.wallets.filter(
                  (wallet) =>
                    wallet.chain === chain &&
                    walletFolderIds(wallet).includes(f.id) &&
                    !wallet.archived,
                ).length
              }
              selected={folder === f.id}
              busy={busy}
              onSelect={() => {
                setFolder(f.id);
                resetSelection();
              }}
              onEdit={(target, trigger) => {
                folderActionFocus.current = trigger;
                setFolderForm(target);
                setWalletForm(null);
              }}
              onDelete={(target, trigger) => {
                folderActionFocus.current = trigger;
                setDeletingFolder(target);
              }}
              onArchive={(target) => {
                void mutate(
                  {
                    action: 'folder.archive',
                    id: target.id,
                    revision: target.revision,
                  },
                  'Folder archived. Its wallets are retained.',
                ).then((ok) => {
                  if (ok && folder === target.id) {
                    setFolder('all');
                    resetSelection();
                    rootFolderButton.current?.focus();
                  }
                });
              }}
            />
          ))}
          <Button
            variant="outline"

            disabled={busy || loading}

            onClick={(event) => {
              folderActionFocus.current = event.currentTarget;
              setFolderForm('new');

              setWalletForm(null);
            }}
          >
            <Plus /> New folder
          </Button>
        </aside>
        <div className="wallet-roster-content">
          <div className="wallet-roster-heading">
            <div>
              <h2
                style={
                  currentFolder
                    ? {
                        borderLeft: `3px solid ${currentFolder.color ?? DEFAULT_FOLDER_COLOR}`,
                        paddingLeft: 10,
                      }
                    : undefined
                }
              >
                {currentFolder?.name ??
                  (archived ? 'Archived wallets' : 'All wallets')}
              </h2>
              <small>
                {rows.length} {rows.length === 1 ? 'address' : 'addresses'} ·{' '}
                {chain}
              </small>
            </div>
          </div>
          {walletForm && (
            <form
              className="wallet-roster-form"

              onSubmit={(e) => {
                e.preventDefault();

                void mutate(
                  walletForm === 'new'
                    ? {
                        action: 'wallet.add',

                        folderId: target,

                        wallets: addresses

                          .split(/\r?\n/)

                          .map((a) => a.trim())

                          .filter(Boolean)

                          .map((address) => ({
                            address,
                            label,
                            role,
                            tags: tags
                              .split(',')
                              .map((tag) => tag.trim())
                              .filter(Boolean),
                          })),
                      }
                    : {
                        action: 'wallet.edit',

                        address: walletForm.address,

                        revision: walletForm.revision,

                        folderId: target,

                        label,

                        role,
                        tags: tags
                          .split(',')
                          .map((tag) => tag.trim())
                          .filter(Boolean),
                      },
                  walletForm === 'new'
                    ? 'Public addresses saved. Ownership remains unverified.'
                    : 'Wallet details saved.',
                );
              }}
            >
              <label>
                {walletForm === 'new'
                  ? 'Public addresses, one per line'
                  : 'Public address'}
                <textarea
                  aria-label="Workspace public addresses"

                  value={addresses}

                  disabled={walletForm !== 'new'}

                  rows={walletForm === 'new' ? 4 : 2}

                  onChange={(e) => setAddresses(e.target.value)}

                  required
                />
                <small>Up to 100 per batch. Public addresses only.</small>
              </label>
              <div className="wallet-roster-fields">
                <label htmlFor="workspace-wallet-label">
                  Wallet label
                  <Input
                    id="workspace-wallet-label"

                    value={label}

                    maxLength={60}

                    onChange={(e) => setLabel(e.target.value)}
                  />
                </label>
                <label htmlFor="workspace-wallet-tags">
                  Wallet tags
                  <Input
                    id="workspace-wallet-tags"
                    aria-label="Wallet tags"
                    value={tags}
                    maxLength={318}
                    placeholder="Team, launch, reserve"
                    onChange={(e) => setTags(e.target.value)}
                  />
                  <small>
                    Up to 10 tags, separated by commas. Each tag can have 30
                    characters.
                  </small>
                </label>
                <label>
                  Launch role
                  <select
                    value={role}

                    onChange={(e) => setRole(e.target.value as WalletRole)}
                  >
                    {WALLET_ROLES.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Destination folder
                  <select
                    value={target}

                    onChange={(e) => setTarget(e.target.value)}
                  >
                    <option value="">No folder</option>
                    {walletForm !== 'new' &&
                      target &&
                      !activeFolders.some((f) => f.id === target) && (
                        <option value={target}>
                          {folders.find((f) => f.id === target)?.name ??
                            'Current folder'}{' '}
                          (archived, retained)
                        </option>
                      )}
                    {activeFolders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div>
                <Button
                  type="submit"

                  disabled={busy || !addresses.trim()}
                >
                  {walletForm === 'new'
                    ? 'Save public addresses'
                    : 'Save wallet details'}
                </Button>
                <Button
                  type="button"

                  variant="outline"

                  disabled={busy}

                  onClick={() => setWalletForm(null)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
          <div className="wallet-roster-actions">
            <BrowserWalletVault
              key={chain}
              chain={chain}
              savedAddresses={savedAddresses}
              verifiedAddresses={[...proofs.keys()]}
              onVerified={reload}
              onAddPublic={(addresses) =>
                mutate(
                  {
                    action: 'wallet.add',
                    folderId: currentFolder?.id ?? '',
                    wallets: addresses.map((address) => ({
                      address,
                      label: '',
                      role: 'Recipient',
                    })),
                  },
                  'Public addresses saved. Private keys stay in your browser vault.',
                )
              }
            />
            <Button
              disabled={busy || loading || archived}

              onClick={() => editWallet()}
            >
              <Plus /> Add addresses
            </Button>
            <Button
              variant="outline"

              disabled={!rows.length}

              onClick={exportPublic}
            >
              <Download /> Export public CSV
            </Button>
            <Button variant="outline" onClick={onFunding}>
              Funding review
            </Button>
            <Button
              variant="outline"
              disabled={
                loading ||
                busy ||
                archived ||
                !picks.length ||
                picks.length > 20
              }
              onClick={() => setWarmupOpen(true)}
            >
              Wallet warmup
            </Button>
          </div>
          {picks.length > 0 && (
            <div className="wallet-bulk-actions">
              <span>{picks.length} selected</span>
              <div className="wallet-membership-control" ref={managerControl}>
                {!archived && (
                  <Button
                    ref={managerButton}
                    aria-expanded={managing}
                    aria-controls={managerId}
                    disabled={busy || picks.length > 100}
                    onClick={() => {
                      setFolderQuery('');
                      setManaging(!managing);
                    }}
                  >
                    Manage folders
                  </Button>
                )}
                {managing && !archived && (
                  <section
                    id={managerId}
                    className="wallet-membership-panel"
                    aria-label="Manage wallet folders"
                  >
                    <header>
                      <div>
                        <strong>Assign wallets to folders</strong>
                        <small>{picks.length} selected</small>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Close folder management"
                        onClick={() => {
                          setManaging(false);
                          managerButton.current?.focus();
                        }}
                      >
                        <X aria-hidden="true" />
                      </Button>
                    </header>
                    <p>
                      Add missing memberships. Uncheck a shared folder to remove
                      it. Other folders stay unchanged.
                    </p>
                    <Input
                      ref={managerSearch}
                      aria-label="Search management folders"
                      placeholder="Search folders"
                      value={folderQuery}
                      onChange={(e) => setFolderQuery(e.target.value)}
                    />
                    <div className="wallet-membership-list">
                      {activeFolders
                        .filter((f) =>
                          f.name
                            .toLowerCase()
                            .includes(folderQuery.toLowerCase()),
                        )
                        .map((f) => {
                          const count = picks.filter((w) =>
                            walletFolderIds(w).includes(f.id),
                          ).length;
                          const all = count === picks.length;
                          return (
                            <label key={f.id} data-partial={count > 0 && !all}>
                              <Folder
                                aria-hidden="true"
                                style={{
                                  color: f.color ?? DEFAULT_FOLDER_COLOR,
                                }}
                              />
                              <span>{f.name}</span>
                              <input
                                type="checkbox"
                                checked={all}
                                aria-label={`Membership in ${f.name}`}
                                disabled={busy || picks.length > 100}
                                onChange={() =>
                                  void mutate(
                                    {
                                      action: 'wallet.folder-toggle',
                                      wallets: picks.map((w) => ({
                                        address: w.address,
                                        revision: w.revision,
                                      })),
                                      folder: {
                                        id: f.id,
                                        revision: f.revision,
                                      },
                                      member: !all,
                                    },
                                    all
                                      ? `Removed ${f.name} from selected wallets.`
                                      : `Added missing memberships in ${f.name}.`,
                                  )
                                }
                              />
                              <small>
                                {count} of {picks.length} selected
                              </small>
                            </label>
                          );
                        })}
                      {!activeFolders.some((f) =>
                        f.name
                          .toLowerCase()
                          .includes(folderQuery.toLowerCase()),
                      ) && <p>No folders found.</p>}
                    </div>
                  </section>
                )}
              </div>
              {!archived && (
                <>
                  <select
                    aria-label="Move selected wallets to folder"

                    value={moveTarget}

                    onChange={(e) => setMoveTarget(e.target.value)}

                    disabled={busy}
                  >
                    <option value="">Choose destination</option>
                    {activeFolders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    disabled={busy || !moveTarget || picks.length > 100}

                    onClick={() =>
                      void mutate(
                        {
                          action: 'wallet.move',

                          folderId: moveTarget,

                          wallets: picks.map((w) => ({
                            address: w.address,

                            revision: w.revision,
                          })),
                        },
                        'Selected wallets moved.',
                      )
                    }
                  >
                    Move selected
                  </Button>
                </>
              )}
              <Button
                variant="outline"

                disabled={busy || picks.length > 100}

                onClick={() =>
                  void mutate(
                    {
                      action: archived ? 'wallet.restore' : 'wallet.archive',

                      wallets: picks.map((w) => ({
                        address: w.address,

                        revision: w.revision,
                      })),
                    },
                    archived
                      ? 'Selected wallets restored.'
                      : 'Selected wallets archived.',
                  )
                }
              >
                {archived ? 'Restore selected' : 'Archive selected'}
              </Button>
            </div>
          )}
          <div className="wallet-balance-summary">
            <div>
              <small>
                {picks.length ? 'SELECTED WALLETS' : 'CURRENT VIEW'} · NATIVE
                BALANCE
              </small>
              <strong>
                {combined
                  ? `${combined.amount} ${combined.currency}`
                  : 'No combined observation'}
              </strong>
              <p>
                {combined
                  ? `${combined.count} ${combined.count === 1 ? 'address' : 'addresses'} · ${chain === 'Solana' ? 'slot' : 'block'} ${combined.blockNumber} · ${combined.commitment} · observed ${new Date(combined.observedAt).toLocaleString()}`
                  : 'Refresh this view or selection for balances from one snapshot.'}
              </p>
              <small>
                Native currency only. Observations can become stale. No USD
                valuation or P&amp;L.
              </small>
            </div>
            <Button
              variant="outline"

              disabled={
                busy ||
                loading ||
                archived ||
                !balanceTargets.length ||
                balanceTargets.length > 100
              }

              onClick={() => void refreshBalances()}
            >
              Refresh {picks.length ? 'selected' : 'view'} balances
            </Button>
            {balanceTargets.length > 100 && (
              <small>Select up to 100 wallets per refresh.</small>
            )}
          </div>
          {warmupOpen &&
            !archived &&
            picks.length > 0 &&
            picks.length <= 20 && (
              <WalletWarmup
                key={
                  chain +
                  picks.map((w) => w.address + ':' + w.revision).join(',')
                }
                chain={chain}
                addresses={picks.map((w) => w.address)}
                walletRevisions={picks.map((w) => ({
                  address: w.address,
                  revision: w.revision,
                }))}
                initialPlan={
                  initialWarmup?.document.chain === chain &&
                  initialWarmup.document.addresses.length === picks.length &&
                  initialWarmup.document.addresses.every((a) =>
                    picks.some((w) => w.address === a),
                  )
                    ? initialWarmup
                    : undefined
                }
                onClose={() => setWarmupOpen(false)}
              />
            )}
          {chain === 'Solana' && (
            <NativeWithdrawalPanel
              key={withdrawalChoice?.id || 'manual-withdrawal'}
              wallets={data.wallets}
              initialOpen={Boolean(initialWithdrawalWallet)}
              initialWallet={
                withdrawalChoice?.wallet ||
                initialWithdrawalWallet ||
                (picks.length === 1 ? picks[0].address : undefined)
              }
              initialToken={
                withdrawalChoice
                  ? {
                      mint: withdrawalChoice.mint,
                      decimals: withdrawalChoice.decimals,
                    }
                  : undefined
              }
            />
          )}
          {chain === 'Solana' && <TokenToolsPanel wallets={data.wallets} />}
          {chain === 'Solana' && holdingsWallet && (
            <WalletHoldingsPanel
              key={holdingsWallet.address}

              address={holdingsWallet.address}

              label={holdingsWallet.label}

              active={!holdingsWallet.archived}
              onWithdraw={(holding) =>
                setWithdrawalChoice({
                  id: crypto.randomUUID(),
                  wallet: holdingsWallet.address,
                  mint: holding.mint,
                  decimals: holding.decimals,
                })
              }

              onClose={() => setHoldingsAddress(null)}
            />
          )}
          {chain !== 'Solana' && holdingsWallet && (
            <EvmHoldingsPanel
              key={chain + '/' + holdingsWallet.address}

              chain={chain}

              address={holdingsWallet.address}

              label={holdingsWallet.label}

              active={!holdingsWallet.archived}

              onClose={() => setHoldingsAddress(null)}
            />
          )}
          <div className="wallet-roster-table">
            <table className="project-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"

                      data-wallet-selection
                      aria-label="Select visible wallets"

                      disabled={
                        busy || loading || !rows.length || rows.length > 100
                      }

                      checked={
                        rows.length > 0 &&
                        rows.every((w) => selected.includes(w.address))
                      }

                      onChange={(e) =>
                        setSelected(
                          e.target.checked ? rows.map((w) => w.address) : [],
                        )
                      }
                    />
                  </th>
                  <th>Wallet</th>
                  <th>Role</th>
                  <th>Native balance</th>
                  <th>Folder</th>
                  <th>Ownership</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={w.address}>
                    <td>
                      <input
                        type="checkbox"

                        data-wallet-selection
                        aria-label={`Select ${w.label || w.address}`}

                        disabled={
                          busy ||
                          (selected.length >= 100 &&
                            !selected.includes(w.address))
                        }

                        checked={selected.includes(w.address)}

                        onChange={(e) =>
                          setSelected((v) =>
                            e.target.checked
                              ? [...v, w.address]
                              : v.filter((a) => a !== w.address),
                          )
                        }
                      />
                    </td>
                    <td>
                      <strong>{w.label || 'Unnamed wallet'}</strong>
                      {!!w.tags?.length && (
                        <div aria-label="Wallet tags">
                          {w.tags.map((tag) => (
                            <span className="draft-badge" key={tag}>
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                      <code title={w.address}>{w.address}</code>
                    </td>
                    <td>{w.role}</td>
                    <td className="wallet-native-balance">
                      {balances.has(w.address) ? (
                        <>
                          <strong>
                            {balances.get(w.address)!.amount}{' '}
                            {balances.get(w.address)!.currency}
                          </strong>
                          <small
                            title={`${balances.get(w.address)!.source} · ${chain === 'Solana' ? 'slot' : 'block'} ${balances.get(w.address)!.blockNumber}${balances.get(w.address)!.blockHash ? ` · ${balances.get(w.address)!.blockHash}` : ''}`}
                          >
                            Observed{' '}
                            {new Date(
                              balances.get(w.address)!.observedAt,
                            ).toLocaleString()}
                          </small>
                        </>
                      ) : (
                        <span>Not observed</span>
                      )}
                    </td>
                    <td>
                      {folders
                        .filter((f) => walletFolderIds(w).includes(f.id))
                        .map((f) => f.name)
                        .join(', ') || 'No folder'}
                    </td>
                    <td>
                      {proofs.has(w.address) ? (
                        <span
                          className="wallet-signature-verified"

                          title={`Signature verified ${new Date(proofs.get(w.address)!).toLocaleString()}. Historical proof, not transaction approval.`}
                        >
                          Signature verified
                          <small>
                            {new Date(proofs.get(w.address)!).toLocaleString()}
                          </small>
                        </span>
                      ) : (
                        <span className="wallet-unverified">Unverified</span>
                      )}
                    </td>
                    <td>
                      <Button
                        variant="outline"

                        disabled={busy || w.archived}

                        aria-label={`Edit ${w.label || w.address}`}

                        onClick={() => editWallet(w)}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="outline"

                        disabled={busy || loading}

                        aria-label={
                          'Token holdings for ' + (w.label || w.address)
                        }

                        onClick={() => setHoldingsAddress(w.address)}
                      >
                        Tokens
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length && (
            <div className="project-empty">
              <Folder />
              <h3>
                {loading
                  ? 'Loading wallets…'
                  : query
                    ? 'No matching wallets'
                    : archived
                      ? 'No archived wallets'
                      : 'Add your public wallet addresses'}
              </h3>
              <p>
                {!loading && !query && !archived
                  ? 'Choose a network and save public addresses. Folder assignment is optional.'
                  : 'Your folder contents stay separate from the public tracker.'}
              </p>
            </div>
          )}
        </div>
      </div>
      {chain === 'Solana' ? (
        <details className="wallet-connection-panel">
          <summary>Connect and verify a Solana devnet wallet</summary>
          <WalletConsole />
        </details>
      ) : (
        <EvmWalletConnection
          key={chain}

          chain={chain}

          savedAddresses={savedAddresses}

          disabled={busy || loading}

          onSaveAddress={(address) => {
            editWallet();

            setAddresses(address);

            setLabel('Connected wallet');

            setNotice(
              'Save your connected account. Folder assignment is optional.',
            );
          }}

          onVerified={reload}
        />
      )}
    </section>
  );
}
