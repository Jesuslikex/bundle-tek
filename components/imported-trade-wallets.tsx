'use client';
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import {
  validatedInventoryItems,
  importedWalletInventory,
  inventoryRetainedRefresh,
  inventorySupplyShare,
  type ImportedWalletInventory,
} from '@/lib/imported-wallet-inventory';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ImportedWalletSellReview } from './imported-wallet-sell-review';
import type { HoldingsSnapshot } from '@/lib/wallet-holdings';
import { subscribeImportedReceiptSaved } from '@/lib/imported-receipt-events';
import type { WorkspaceWallet, WalletFolder } from '@/lib/wallet-workspace';
import {
  formatNativeBalance,
  type WalletBalance,
} from '@/lib/wallet-balance-format';

export function ImportedTradeWallets({
  wallets,
  folders,
  balances,
  selected,
  locked,
  onReview,
  project,
}: {
  wallets: WorkspaceWallet[];
  folders: WalletFolder[];
  balances: WalletBalance[];
  selected: string;
  locked: boolean;
  onReview: (
    wallet: WorkspaceWallet,
    side: 'Buy' | 'Sell',
    amount?: string,
  ) => void;
  project?: ImportedTokenProject;
}) {
  const [inventory, setInventory] = useState<ImportedWalletInventory[] | null>(
      null,
    ),
    [reading, setReading] = useState(false),
    [inventoryError, setInventoryError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const epochs = useRef(new Map<string, number>());
  const [staleWallets, setStaleWallets] = useState(new Set<string>());
  useEffect(() => {
    if (!project) return;
    return subscribeImportedReceiptSaved(
      { projectId: project.id, mint: project.document.token.address },
      (notice) => {
        epochs.current.set(
          notice.wallet,
          (epochs.current.get(notice.wallet) ?? 0) + 1,
        );
        setStaleWallets((old) => new Set(old).add(notice.wallet));
      },
    );
  }, [project]);

  useEffect(() => () => pending.current?.abort(), []);
  async function readInventory(refreshWallet?: WorkspaceWallet) {
    if (!project) return;
    const refreshEpoch = refreshWallet
      ? (epochs.current.get(refreshWallet.address) ?? 0)
      : null;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setReading(true);
    setInventoryError('');
    try {
      let refreshed: ImportedWalletInventory | undefined;
      if (refreshWallet) {
        const response = await fetch('/api/wallet-workspace/holdings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            chain: 'Solana',
            address: refreshWallet.address,
          }),
        });
        const data = (await response.json()) as {
          error?: string;
          snapshot?: HoldingsSnapshot;
        };
        if (!response.ok)
          throw new Error(data.error || 'Token holdings refresh unavailable.');
        if (!data.snapshot)
          throw new Error('Fresh token holdings evidence is missing.');
        refreshed = importedWalletInventory(
          data.snapshot,
          refreshWallet.address,
          refreshWallet.revision,
          project.document.token.address,
          project.document.token.decimals,
        );
      }
      const response = await fetch(
        '/api/imported-projects/inventory?' +
          new URLSearchParams({
            id: project.id,
            revision: String(project.revision),
          }),
        { signal: controller.signal, cache: 'no-store' },
      );
      const data = (await response.json()) as {
        id?: string;
        revision?: number;
        mint?: string;
        decimals?: number;
        executionAllowed?: boolean;
        items?: unknown;
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || 'Saved token inventory unavailable.');
      if (
        data.id !== project.id ||
        data.revision !== project.revision ||
        data.mint !== project.document.token.address ||
        data.decimals !== project.document.token.decimals ||
        data.executionAllowed !== false
      )
        throw new Error('Inventory project context changed.');
      const items = validatedInventoryItems(
        data.items,
        wallets.filter((w) => w.chain === 'Solana' && !w.archived),
        project.document.token.decimals,
      );
      if (!controller.signal.aborted) {
        setInventory(items);
        if (refreshed && !inventoryRetainedRefresh(items, refreshed))
          setInventoryError(
            'Saved inventory does not match the completed refresh. Refresh this wallet again before using sell percentages.',
          );
        if (
          refreshWallet &&
          refreshed &&
          inventoryRetainedRefresh(items, refreshed) &&
          (epochs.current.get(refreshWallet.address) ?? 0) === refreshEpoch
        )
          setStaleWallets((old) => {
            const next = new Set(old);
            next.delete(refreshWallet.address);
            return next;
          });
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setInventoryError(
          error instanceof Error ? error.message : 'Inventory unavailable.',
        );
    } finally {
      if (!controller.signal.aborted) setReading(false);
    }
  }
  const searchId = useId();
  const [percentageWallet, setPercentageWallet] = useState('');
  const [search, setSearch] = useState(''),
    [folder, setFolder] = useState(''),
    [role, setRole] = useState(''),
    [page, setPage] = useState(0);
  const activeFolders = folders.filter(
    (f) => f.chain === 'Solana' && !f.archived,
  );
  const names = new Map(activeFolders.map((f) => [f.id, f.name]));
  const rows = wallets
    .filter((w) => w.chain === 'Solana' && !w.archived)
    .map((wallet) => {
      const ids = (
        wallet.folderIds ?? (wallet.folderId ? [wallet.folderId] : [])
      ).filter((id) => names.has(id));
      const folderNames = ids.map((id) => names.get(id)!).join(', ');
      const matches = balances.filter(
        (b) => b.chain === 'Solana' && b.address === wallet.address,
      );
      const balance = matches.length === 1 ? matches[0] : undefined;
      let observed: { amount: string; date: string } | undefined;
      if (
        balance &&
        balance.decimals === 9 &&
        balance.currency === 'SOL' &&
        /^(0|[1-9]\d{0,19})$/.test(balance.raw) &&
        BigInt(balance.raw) <= 18446744073709551615n &&
        Number.isFinite(Date.parse(balance.observedAt))
      ) {
        const amount = formatNativeBalance(balance.raw, 9);
        if (amount === balance.amount)
          observed = { amount, date: balance.observedAt };
      }
      return { wallet, ids, folderNames, observed };
    })
    .filter(
      (row) =>
        (!folder ||
          (folder === ':unfiled'
            ? row.ids.length === 0
            : row.ids.includes(folder))) &&
        (!role || row.wallet.role === role) &&
        `${row.wallet.label} ${row.wallet.address} ${row.wallet.tags?.join(' ') ?? ''} ${row.folderNames}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    );
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(rows.length / 25) - 1),
  );
  return (
    <section
      aria-label="Project trade wallets"
      className="imported-trade-wallets"
    >
      <h4>My trade wallets</h4>
      <p>
        Select a wallet to review a buy or sell. Saved SOL observations may be
        old. Preparation checks fresh balances and each transaction requires
        signing approval.
      </p>
      {project && (
        <>
          <Button
            variant="outline"
            disabled={locked || reading}
            onClick={() => void readInventory()}
          >
            {reading
              ? 'Reading project inventory…'
              : 'Review saved token inventory'}
          </Button>
          <p>
            Token observations have separate timestamps. Supply share uses the
            project supply observed at {project.document.token.observedAt}.
            Frozen units are separate; unfrozen units do not prove
            transferability. Refresh one wallet at a time, with 15 seconds
            between provider reads.
          </p>
        </>
      )}
      {staleWallets.size > 0 && (
        <output>
          Token inventory changed after a finalized trade. Refresh affected
          wallets individually. Reloading saved inventory does not establish
          fresh balances.
        </output>
      )}
      {inventoryError && <p role="alert">{inventoryError}</p>}
      <div className="imported-trade-wallet-filters">
        <label htmlFor={searchId}>
          Search trade wallets
          <Input
            id={searchId}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Label, address, tag or folder"
          />
        </label>
        <label>
          Trade wallet folder
          <select
            value={folder}
            onChange={(e) => {
              setFolder(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All folders</option>
            <option value=":unfiled">No active folder</option>
            {activeFolders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Trade wallet role
          <select
            value={role}
            onChange={(e) => {
              setRole(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All roles</option>
            {['Recipient', 'Deployer', 'Funder'].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="imported-trade-wallet-table">
        <table>
          <caption>
            {rows.length} matching active Solana wallets. Reviews select one
            wallet at a time.
          </caption>
          <thead>
            <tr>
              <th scope="col">Wallet</th>
              <th scope="col">Role / folders</th>
              <th scope="col">Saved SOL observation</th>
              {project && (
                <>
                  <th scope="col">
                    {project.document.token.symbol} observation
                  </th>
                  <th scope="col">Observed supply share</th>
                </>
              )}
              <th scope="col">Review</th>
            </tr>
          </thead>
          <tbody>
            {rows
              .slice(currentPage * 25, (currentPage + 1) * 25)
              .map(({ wallet, folderNames, observed }) => {
                const token = inventory?.find(
                  (item) => item.wallet === wallet.address,
                )?.observation;
                let share: string | null = null;
                if (token && project)
                  try {
                    share = inventorySupplyShare(
                      token.raw,
                      project.document.token.totalSupplyRaw,
                    );
                  } catch {
                    /* Damaged supply is unavailable. */
                  }
                return (
                  <Fragment key={wallet.address}>
                    <tr aria-selected={selected === wallet.address}>
                      <td>
                        <strong>{wallet.label || 'Unlabeled wallet'}</strong>
                        <code>{wallet.address}</code>
                        {selected === wallet.address && (
                          <span>Selected for review</span>
                        )}
                      </td>
                      <td data-label="Role / folders">
                        {wallet.role}
                        <small>{folderNames || 'No active folder'}</small>
                      </td>
                      <td data-label="Saved SOL observation">
                        {observed ? (
                          <>
                            <strong>{observed.amount} SOL</strong>
                            <small>{observed.date}</small>
                          </>
                        ) : (
                          <span>No valid saved observation</span>
                        )}
                      </td>
                      {project && (
                        <>
                          <td
                            data-label={`${project.document.token.symbol} observation`}
                          >
                            {token ? (
                              <>
                                {staleWallets.has(wallet.address) && (
                                  <p>
                                    Trade finalized. Refresh this wallet&apos;s
                                    token holdings before using sell
                                    percentages.
                                  </p>
                                )}
                                <strong>
                                  {token.amount} {project.document.token.symbol}
                                </strong>
                                <small>
                                  {token.unfrozenRaw} unfrozen /{' '}
                                  {token.frozenRaw} frozen atomic units
                                </small>
                                <small>{token.observedAt}</small>
                                <small>
                                  {token.source} · slots {token.minSlot} to{' '}
                                  {token.maxSlot}
                                </small>
                              </>
                            ) : (
                              <span>
                                {inventory
                                  ? 'No saved token observation'
                                  : 'Inventory not reviewed'}
                              </span>
                            )}
                            <Button
                              variant="outline"
                              disabled={locked || reading}
                              aria-label={`Refresh token holdings for ${wallet.address}`}
                              onClick={() => void readInventory(wallet)}
                            >
                              Refresh tokens
                            </Button>
                          </td>
                          <td data-label="Observed supply share">
                            {token
                              ? (share ?? 'Supply comparison unavailable')
                              : 'Unavailable'}
                          </td>
                        </>
                      )}
                      <td
                        className="imported-trade-wallet-actions"
                        data-label="Review"
                      >
                        <Button
                          variant="outline"
                          disabled={locked || reading}
                          aria-label={`Review buy with ${wallet.address}`}
                          onClick={() => onReview(wallet, 'Buy')}
                        >
                          Buy review
                        </Button>
                        <Button
                          variant="outline"
                          disabled={locked || reading}
                          aria-label={`Review sell with ${wallet.address}`}
                          onClick={() => onReview(wallet, 'Sell')}
                        >
                          Sell review
                        </Button>
                        {project && (
                          <Button
                            variant="outline"
                            disabled={
                              locked ||
                              reading ||
                              staleWallets.has(wallet.address)
                            }
                            aria-expanded={percentageWallet === wallet.address}
                            aria-label={`Show sell percentages for ${wallet.address}`}
                            onClick={() =>
                              setPercentageWallet(
                                percentageWallet === wallet.address
                                  ? ''
                                  : wallet.address,
                              )
                            }
                          >
                            Sell percentages
                          </Button>
                        )}
                      </td>
                    </tr>
                    {project && percentageWallet === wallet.address && (
                      <tr>
                        <td colSpan={6}>
                          <ImportedWalletSellReview
                            key={`${project.id}:${project.revision}:${wallet.address}:${wallet.revision}`}
                            project={project}
                            wallet={wallet}
                            locked={
                              locked ||
                              reading ||
                              staleWallets.has(wallet.address)
                            }
                            onReview={(amount) =>
                              onReview(wallet, 'Sell', amount)
                            }
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            {!rows.length && (
              <tr>
                <td colSpan={project ? 6 : 4}>
                  No active wallets match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length > 25 && (
        <nav aria-label="Trade wallet pages">
          <Button
            variant="outline"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous wallets
          </Button>
          <span>
            Page {currentPage + 1} of {Math.ceil(rows.length / 25)}
          </span>
          <Button
            variant="outline"
            disabled={(currentPage + 1) * 25 >= rows.length}
            onClick={() => setPage(currentPage + 1)}
          >
            Next wallets
          </Button>
        </nav>
      )}
    </section>
  );
}
