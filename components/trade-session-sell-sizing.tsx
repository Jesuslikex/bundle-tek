'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import {
  validatedInventoryItems,
  type ImportedWalletInventory,
} from '@/lib/imported-wallet-inventory';
import {
  sizeSessionSellPercentage,
  sizeSessionSupplyPercentage,
} from '@/lib/trade-session-sell-sizing';
import { IMPORTED_SUPPLY_SELL_PRESETS } from '@/lib/imported-balance-review';
import { subscribeImportedReceiptSaved } from '@/lib/imported-receipt-events';
export function TradeSessionSellSizing({
  project,
  roster,
  selected,
  disabled,
  onApply,
  onInvalidate,
}: {
  project: ImportedTokenProject;
  roster: WorkspaceWallet[];
  selected: WorkspaceWallet[];
  disabled: boolean;
  onApply: (amounts: string[]) => void;
  onInvalidate: (wallet: string, amount: string) => void;
}) {
  const [inventory, setInventory] = useState<ImportedWalletInventory[] | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const pending = useRef<AbortController | null>(null),
    minimumTimes = useRef(new Map<string, number>());
  const applied = useRef(new Map<string, string>());
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(
    () =>
      subscribeImportedReceiptSaved(
        { projectId: project.id, mint: project.document.token.address },
        (event) => {
          minimumTimes.current.set(event.wallet, Date.now());
          const amount = applied.current.get(event.wallet);
          if (amount !== undefined) onInvalidate(event.wallet, amount);
          applied.current.delete(event.wallet);
          pending.current?.abort();
          setBusy(false);
          setInventory(null);
          setNotice(
            'A trade finalized. Refresh affected wallet holdings and reload session inventory before applying sell percentages.',
          );
        },
      ),
    [project.id, project.document.token.address, onInvalidate],
  );
  async function load(refresh = false) {
    if (busy || disabled) return;
    const c = new AbortController();
    pending.current = c;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        refresh
          ? '/api/imported-projects/inventory/refresh'
          : '/api/imported-projects/inventory?' +
              new URLSearchParams({
                id: project.id,
                revision: String(project.revision),
                scope: 'mint',
              }),
        {
          method: refresh ? 'POST' : 'GET',
          headers: refresh ? { 'content-type': 'application/json' } : undefined,
          body: refresh
            ? JSON.stringify({
                id: project.id,
                revision: project.revision,
                scope: 'mint',
                wallets: selected.map((w) => ({
                  address: w.address,
                  revision: w.revision,
                })),
              })
            : undefined,
          cache: 'no-store',
          signal: AbortSignal.any([
            c.signal,
            AbortSignal.timeout(refresh ? 45000 : 15000),
          ]),
        },
      );
      const data = (await response.json()) as {
        id: string;
        revision: number;
        mint: string;
        decimals: number;
        executionAllowed: boolean;
        items: unknown;
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || 'Saved session inventory unavailable.');
      if (
        data.id !== project.id ||
        data.revision !== project.revision ||
        data.mint !== project.document.token.address ||
        data.decimals !== project.document.token.decimals ||
        data.executionAllowed !== false
      )
        throw new Error('Session inventory context changed.');
      const items = validatedInventoryItems(
        data.items,
        refresh ? selected : roster,
        project.document.token.decimals,
      );
      if (!c.signal.aborted) {
        setInventory(items);
        setNotice('');
      }
    } catch (e) {
      if (!c.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : 'Saved session inventory unavailable.',
        );
    } finally {
      if (pending.current === c) {
        pending.current = null;
        if (!c.signal.aborted) setBusy(false);
      }
    }
  }
  return (
    <section
      className="space-y-2 rounded-md border p-3"
      aria-label="Session sell percentages"
    >
      <h5>Sell a percentage of each wallet</h5>
      <p>
        Uses each selected wallet&apos;s saved unfrozen token units, rounded
        down independently. Every observation must be within 60 seconds. Refresh
        selected holdings together here or load retained observations. Wallet
        observations can come from different slots; signing rechecks every
        entry.
      </p>
      <div className="wallet-roster-actions">
        <Button
          variant="outline"
          disabled={busy || disabled || !selected.length}
          onClick={() => void load(true)}
        >
          Refresh selected token holdings
        </Button>
        <Button
          variant="outline"
          disabled={busy || disabled || !selected.length}
          onClick={() => void load()}
        >
          {busy
            ? 'Loading session inventory…'
            : 'Load saved inventory for session'}
        </Button>
      </div>
      <div className="wallet-roster-actions">
        {[25, 50, 75, 100].map((percentage) => (
          <Button
            key={percentage}
            variant="outline"
            disabled={busy || disabled || !inventory || !selected.length}
            onClick={() => {
              if (!inventory) return;
              try {
                const amounts = sizeSessionSellPercentage(
                  inventory,
                  selected,
                  project.document.token.decimals,
                  percentage,
                  Date.now(),
                  minimumTimes.current,
                );
                applied.current = new Map(
                  selected.map((wallet, index) => [
                    wallet.address,
                    amounts[index],
                  ]),
                );
                onApply(amounts);
                setError('');
                setNotice(
                  `Applied ${percentage}% of observed unfrozen units to ${selected.length} selected wallets. Review the exact inputs below before saving.`,
                );
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : 'Sell percentage unavailable.',
                );
              }
            }}
          >
            Apply {percentage}% to session wallets
          </Button>
        ))}
      </div>
      {inventory && (
        <section aria-label="Session supply percentages">
          <h5>Sell a total percentage of supply</h5>
          <p>
            Uses saved total supply observed{' '}
            {new Date(project.document.token.observedAt).toLocaleString()}.
            Distributes one total across selected wallets in proportion to
            unfrozen holdings, with exact remainder allocation. Supply may have
            changed.
          </p>
          <div className="wallet-roster-actions">
            {IMPORTED_SUPPLY_SELL_PRESETS.map((preset) => (
              <Button
                key={preset.basisPoints}
                type="button"
                variant="outline"
                disabled={busy || disabled || !selected.length}
                onClick={() => {
                  try {
                    const token = project.document.token;
                    const result = sizeSessionSupplyPercentage(
                      inventory,
                      selected,
                      {
                        mint: token.address,
                        decimals: token.decimals,
                        totalSupplyRaw: token.totalSupplyRaw,
                        observedAt: token.observedAt,
                      },
                      preset.basisPoints,
                      Date.now(),
                      minimumTimes.current,
                    );
                    applied.current = new Map(
                      selected.map((wallet, index) => [
                        wallet.address,
                        result.amounts[index],
                      ]),
                    );
                    onApply(result.amounts);
                    setError('');
                    setNotice(
                      `Applied ${preset.label} of saved total supply: ${result.totalAmount} ${token.symbol} across ${selected.length} wallets. Review exact per-wallet inputs before saving.`,
                    );
                  } catch (e) {
                    setError(
                      e instanceof Error
                        ? e.message
                        : 'Supply allocation unavailable.',
                    );
                  }
                }}
              >
                Apply total {preset.label} supply to session
              </Button>
            ))}
          </div>
        </section>
      )}
      {inventory && (
        <ul>
          {selected.map((w) => {
            const o = inventory.find(
              (i) => i.wallet === w.address,
            )?.observation;
            return (
              <li key={w.address}>
                {w.label || w.address}:{' '}
                {o
                  ? `${o.unfrozenRaw} unfrozen atomic units, ${o.frozenRaw} frozen; ${o.scope === 'mint' ? 'token-specific inventory; ' : ''}observed ${new Date(o.observedAt).toLocaleString()}`
                  : 'No saved token observation'}
              </li>
            );
          })}
        </ul>
      )}
      {notice && <output style={{ display: 'block' }}>{notice}</output>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
