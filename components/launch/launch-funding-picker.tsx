'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { LaunchPlanInput, LaunchChain } from '@/lib/launch-plan';
import type { LaunchWalletAssignments } from '@/lib/launch-wallets';
import type { WalletWorkspace } from '@/lib/wallet-workspace';
import {
  launchFundingRecipients,
  launchDistributionFundingRecipients,
} from '@/lib/launch-funding';
export function LaunchFundingPicker({
  selection,
  plan,
  chain,
  currency,
  assetAddress,
  onApply,
  onBusyChange,
}: {
  selection?: LaunchWalletAssignments;
  plan: LaunchPlanInput;
  chain: LaunchChain;
  currency: string;
  assetAddress?: string;
  onApply: (recipients: { address: string; amount: string }[]) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [allocationMode, setAllocationMode] = useState<
      'equal' | 'distribution'
    >('equal'),
    [amount, setAmount] = useState('0.01'),
    [deployerAmount, setDeployerAmount] = useState('0.01'),
    [includeDeployer, setIncludeDeployer] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      abort.current?.abort();
      onBusyChange(false);
    },
    [onBusyChange],
  );
  async function apply() {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    onBusyChange(true);
    setError('');
    try {
      const response = await fetch('/api/wallet-workspace', {
        cache: 'no-store',
        signal: controller.signal,
      });
      const workspace = (await response.json()) as WalletWorkspace & {
        error?: string;
      };
      if (
        !response.ok ||
        !Array.isArray(workspace.wallets) ||
        !Array.isArray(workspace.folders)
      )
        throw new Error(workspace.error || 'Wallet workspace unavailable.');
      const recipients =
        allocationMode === 'distribution'
          ? launchDistributionFundingRecipients(
              plan,
              selection,
              workspace,
              chain,
              currency,
              includeDeployer,
              deployerAmount,
              assetAddress,
            )
          : launchFundingRecipients(
              selection,
              workspace,
              chain,
              amount,
              includeDeployer,
              deployerAmount,
            );
      if (!controller.signal.aborted) onApply(recipients);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : 'Launch selection could not be copied.',
        );
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  }
  return (
    <section
      className="funding-wallet-picker launch-funding-picker"
      aria-label="Use launch wallet selection"
    >
      <h3>Use launch wallet selection</h3>
      <p>
        Copy the selected launch recipients into this funding draft. This
        replaces its address list after current roster checks and amount
        validation. Funding currency is {currency}, independently of the launch
        quote.
      </p>
      <label>
        Allocation source
        <select
          aria-label="Launch funding allocation source"
          value={allocationMode}
          disabled={busy}
          onChange={(e) =>
            setAllocationMode(e.target.value as 'equal' | 'distribution')
          }
        >
          <option value="equal">Same amount per recipient</option>
          <option value="distribution">Saved holder distribution</option>
        </select>
      </label>
      {allocationMode === 'distribution' && (
        <p>
          Copy the exact current holder preview in slot order. Every slot needs
          a selected Recipient and a positive amount. Native quote equivalents
          only; fees and reserves are excluded.
        </p>
      )}
      <div className="wallet-roster-fields">
        <label>
          Amount per launch recipient ({currency})
          <Input
            aria-label="Launch recipient funding amount"
            value={amount}
            inputMode="decimal"
            disabled={busy || allocationMode === 'distribution'}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        {selection?.deployer && (
          <label>
            Deployer amount ({currency})
            <Input
              aria-label="Launch deployer funding amount"
              value={deployerAmount}
              inputMode="decimal"
              disabled={busy || !includeDeployer}
              onChange={(e) => setDeployerAmount(e.target.value)}
            />
          </label>
        )}
      </div>
      <label className="launch-funding-include">
        <input
          type="checkbox"
          aria-label="Include launch deployer allocation"
          checked={includeDeployer}
          disabled={busy || !selection?.deployer}
          onChange={(e) => setIncludeDeployer(e.target.checked)}
        />
        Include the selected deployer as a separate allocation
      </label>
      <p>
        {selection?.recipients.length ?? 0} launch recipients selected
        {selection?.deployer ? ' · deployer available' : ''}. A funding draft
        supports at most 100 total addresses.
      </p>
      <Button
        variant="outline"
        type="button"
        disabled={busy || !selection || selection.chain !== chain}
        onClick={() => void apply()}
      >
        {busy ? 'Checking launch wallets…' : 'Copy launch allocations'}
      </Button>
      {(!selection || selection.chain !== chain) && (
        <p>Choose launch wallet roles on {chain} in Launch Settings first.</p>
      )}
      {error && (
        <p role="alert" className="tracker-error">
          {error}
        </p>
      )}
    </section>
  );
}
