'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LaunchPlanInput } from '@/lib/launch-plan';
import {
  activeLaunchWallets,
  assignmentEntries,
  referenceForWallet,
  walletReferenceFolderMatches,
  type LaunchWalletAssignments,
} from '@/lib/launch-wallets';
import { walletFolderIds, type WalletWorkspace } from '@/lib/wallet-workspace';
import { Button } from '@/components/ui/button';

export function LaunchWalletPicker({
  plan,
  selection,
  onChange,
  onOpenWallets,
}: {
  plan: LaunchPlanInput;
  selection?: LaunchWalletAssignments;
  onChange: (value: LaunchWalletAssignments | undefined) => void;
  onOpenWallets: () => void;
}) {
  const [workspace, setWorkspace] = useState<WalletWorkspace>({
    folders: [],
    wallets: [],
  });
  const [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [folder, setFolder] = useState('');
  const abort = useRef<AbortController | null>(null);
  const load = useCallback(() => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    return fetch('/api/wallet-workspace', {
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = (await response.json()) as WalletWorkspace & {
          error?: string;
        };
        if (!response.ok)
          throw new Error(data.error ?? 'Wallet workspace unavailable.');
        if (!Array.isArray(data.folders) || !Array.isArray(data.wallets))
          throw new Error('Invalid wallet workspace response.');
        if (!controller.signal.aborted) setWorkspace(data);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Wallet workspace unavailable.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
  }, []);
  useEffect(() => {
    void load();
    return () => abort.current?.abort();
  }, [load]);
  const active = activeLaunchWallets(workspace, plan.chain),
    deployers = active.filter((w) => w.role === 'Deployer'),
    recipients = active.filter((w) => w.role === 'Recipient');
  const chosen =
    selection?.chain === plan.chain
      ? selection
      : { chain: plan.chain, recipients: [] };
  const folders = workspace.folders.filter(
    (f) => f.chain === plan.chain && !f.archived,
  );
  const setDeployer = (address: string) =>
    onChange({
      ...chosen,
      deployer: address
        ? referenceForWallet(
            deployers.find((w) => w.address === address)!,
            workspace,
          )
        : undefined,
    });
  const addFolder = () => {
    const next = [...chosen.recipients];
    for (const wallet of recipients.filter((w) =>
      walletFolderIds(w).includes(folder),
    ))
      if (!next.some((r) => r.address === wallet.address))
        next.push(referenceForWallet(wallet, workspace, folder));
    if (next.length > plan.holderCount) {
      setError(
        'This folder would exceed the planned holder count. Increase the count or choose fewer recipients.',
      );
      return;
    }
    setError('');
    onChange({ ...chosen, recipients: next });
  };
  const stale = assignmentEntries(chosen).filter((ref) => {
    const wallet = active.find(
      (w) => w.address === ref.address && w.role === ref.role,
    );
    return (
      !wallet ||
      wallet.revision !== ref.revision ||
      !walletReferenceFolderMatches(ref, wallet, workspace)
    );
  });
  return (
    <section className="launch-wallet-picker" aria-label="Launch wallet roles">
      <h2>Launch wallet roles</h2>
      <p>
        Select public addresses from your active {plan.chain} wallet workspace.
        Selection does not provide signing access.
      </p>
      <div className="wallet-roster-actions">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError('');
            void load();
          }}
        >
          Reload wallet choices
        </Button>
        <Button variant="outline" onClick={onOpenWallets}>
          Manage wallet folders
        </Button>
        <Button
          variant="outline"
          disabled={!selection}
          onClick={() => onChange(undefined)}
        >
          Clear role selection
        </Button>
      </div>
      {error && (
        <p role="alert" className="draft-error">
          {error}
        </p>
      )}
      {busy ? (
        <p>Loading wallet choices…</p>
      ) : (
        <>
          {selection && selection.chain !== plan.chain && (
            <p role="alert">
              The retained selection uses another network. Clear it before
              choosing wallets.
            </p>
          )}
          {!!stale.length && (
            <p role="alert">
              {stale.length} selected references are no longer current. Remove
              or reselect them before saving plan changes.
            </p>
          )}
          <label>
            Deployer
            <select
              aria-label="Launch deployer"
              value={chosen.deployer?.address ?? ''}
              onChange={(e) => setDeployer(e.target.value)}
            >
              <option value="">No deployer selected</option>
              {chosen.deployer &&
                !deployers.some(
                  (w) => w.address === chosen.deployer?.address,
                ) && (
                  <option value={chosen.deployer.address}>
                    Unavailable: {chosen.deployer.address}
                  </option>
                )}
              {deployers.map((w) => (
                <option key={w.address} value={w.address}>
                  {w.label || w.address} · {w.address}
                </option>
              ))}
            </select>
          </label>
          {chosen.deployer && (
            <p className="launch-wallet-address">
              Deployer: <code>{chosen.deployer.address}</code>
            </p>
          )}
          <div className="wallet-roster-actions">
            <label>
              Recipient folder
              <select
                aria-label="Launch recipient folder"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
              >
                <option value="">Choose a folder</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="outline" disabled={!folder} onClick={addFolder}>
              Add folder recipients
            </Button>
          </div>
          <p>
            {chosen.recipients.length} / {plan.holderCount} recipients selected.
            Deployer and Funder roles are excluded from recipient folders.
          </p>
          <div className="launch-recipient-choices">
            {recipients
              .filter((w) => !folder || walletFolderIds(w).includes(folder))
              .map((w) => {
                const checked = chosen.recipients.some(
                  (r) => r.address === w.address,
                );
                return (
                  <label key={w.address}>
                    <input
                      type="checkbox"
                      aria-label={`Launch recipient ${w.label || w.address}`}
                      checked={checked}
                      disabled={
                        !checked && chosen.recipients.length >= plan.holderCount
                      }
                      onChange={(e) =>
                        onChange({
                          ...chosen,
                          recipients: e.target.checked
                            ? [
                                ...chosen.recipients,
                                referenceForWallet(
                                  w,
                                  workspace,
                                  folder || undefined,
                                ),
                              ]
                            : chosen.recipients.filter(
                                (r) => r.address !== w.address,
                              ),
                        })
                      }
                    />
                    <span>
                      {w.label || 'Recipient'}
                      <code>{w.address}</code>
                    </span>
                  </label>
                );
              })}
          </div>
          {!!chosen.recipients.length && (
            <details>
              <summary>Review retained recipient addresses</summary>
              {chosen.recipients.map((r) => (
                <div className="launch-selected-recipient" key={r.address}>
                  <code>{r.address}</code>
                  <Button
                    variant="outline"
                    aria-label={`Remove launch recipient ${r.address}`}
                    onClick={() =>
                      onChange({
                        ...chosen,
                        recipients: chosen.recipients.filter(
                          (item) => item.address !== r.address,
                        ),
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </details>
          )}
          {!active.length && (
            <p>
              No active addresses on this network. Create a folder and assign
              Deployer or Recipient roles in My wallets.
            </p>
          )}
        </>
      )}
      <p className="source-note">
        Partial role selections can be saved for later review. Wallet ownership,
        funding and execution remain separate checks.
      </p>
    </section>
  );
}
