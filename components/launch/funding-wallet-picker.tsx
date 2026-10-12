'use client';
import { walletFolderIds } from '@/lib/wallet-workspace';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { LaunchChain } from '@/lib/launch-plan';
import type { WalletWorkspace } from '@/lib/wallet-workspace';
export function FundingWalletPicker({
  chain,
  onApply,
}: {
  chain: LaunchChain;
  onApply: (addresses: string[], amount: string) => void;
}) {
  const [workspace, setWorkspace] = useState<WalletWorkspace | null>(null);
  const [folder, setFolder] = useState('');
  const [amount, setAmount] = useState('0.01');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/wallet-workspace', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (r) => {
        const body = (await r.json()) as WalletWorkspace & { error?: string };
        if (
          !r.ok ||
          !Array.isArray(body.wallets) ||
          !Array.isArray(body.folders)
        )
          throw new Error(body.error || 'Wallet folders unavailable.');
        if (!controller.signal.aborted) {
          setWorkspace(body);
          setError('');
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [reload]);
  const folders =
    workspace?.folders.filter((f) => f.chain === chain && !f.archived) ?? [];
  const recipients =
    workspace?.wallets.filter(
      (w) =>
        w.chain === chain &&
        (folder === 'unassigned'
          ? walletFolderIds(w).length === 0
          : walletFolderIds(w).includes(folder)) &&
        !w.archived &&
        w.role === 'Recipient' &&
        (folder === 'unassigned' || folders.some((f) => f.id === folder)),
    ) ?? [];
  return (
    <div className="funding-wallet-picker">
      <h3>Use wallet folder recipients</h3>
      <p>
        Copies active Recipient addresses into this draft. Replaces the current
        recipient list.
      </p>
      <div className="wallet-roster-fields">
        <label>
          Funding wallet folder
          <select
            value={
              folder === 'unassigned' || folders.some((f) => f.id === folder)
                ? folder
                : ''
            }
            onChange={(e) => setFolder(e.target.value)}
          >
            <option value="">Choose a {chain} folder</option>
            <option value="unassigned">No folder</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="folder-recipient-amount">
          Amount per recipient
          <Input
            id="folder-recipient-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
          />
        </label>
      </div>
      <div className="wallet-roster-actions">
        <Button
          type="button"
          variant="outline"
          disabled={!recipients.length || recipients.length > 100}
          onClick={() => {
            try {
              onApply(
                recipients.map((w) => w.address),
                amount,
              );
              setError('');
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Invalid allocation.');
            }
          }}
        >
          Use {recipients.length}{' '}
          {recipients.length === 1 ? 'recipient' : 'recipients'}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setReload((v) => v + 1)}
        >
          Reload wallet folders
        </Button>
      </div>
      {recipients.length > 100 && (
        <p>Select a folder with at most 100 active recipients.</p>
      )}
      {error && (
        <p role="alert" className="tracker-error">
          {error}
        </p>
      )}
    </div>
  );
}
