'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { createEvmDiscoveryBatch } from '@/lib/evm-discovery-batch';
import type { DiscoveryBatchState } from '@/lib/evm-discovery-batch';
import type { EvmDiscovery } from '@/lib/evm-transaction-discovery';
import type { TrackedWallet } from '@/lib/tracked-wallet';
export function EvmDiscoveryBatch({
  wallet,
  disabled,
  onScan,
  onActive,
}: {
  wallet: TrackedWallet;
  disabled: boolean;
  onScan: (scan: EvmDiscovery) => void;
  onActive: (active: boolean) => void;
}) {
  const driver = useRef<ReturnType<typeof createEvmDiscoveryBatch> | null>(
    null,
  );
  const [state, setState] = useState<DiscoveryBatchState>({
    status: 'off',
    pages: 0,
    reason: '',
  });
  useEffect(() => {
    const context = {
      address: wallet.address,
      network: wallet.network,
      expectedUpdatedAt: wallet.updatedAt,
    };
    const request = async (signal: AbortSignal, scan?: EvmDiscovery) => {
      const response = await fetch(
        scan
          ? '/api/tracker/evm-discovery'
          : `/api/tracker/evm-discovery?${new URLSearchParams(context)}`,
        {
          method: scan ? 'POST' : 'GET',
          cache: 'no-store',
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(scan ? 30000 : 10000),
          ]),
          ...(scan
            ? {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  ...context,
                  action: 'older',
                  expectedDiscoveryObservedAt: scan.observedAt,
                }),
              }
            : {}),
        },
      );
      if (scan && response.status === 429) return null;
      const data = (await response.json()) as {
        discovery: EvmDiscovery | null;
        currentUpdatedAt: string;
        capturedUpdatedAt: string;
        stale: boolean;
        executionAllowed: boolean;
        error?: string;
      };
      if (!response.ok)
        throw new Error(
          data.error || 'Discovery unavailable. Saved pages retained.',
        );
      if (
        data.executionAllowed !== false ||
        data.stale ||
        data.currentUpdatedAt !== wallet.updatedAt ||
        data.capturedUpdatedAt !== wallet.updatedAt ||
        !data.discovery ||
        data.discovery.chain !== wallet.network ||
        data.discovery.address !== wallet.address
      )
        throw new Error(
          'Saved scan is unavailable or belongs to an older wallet revision. Start a latest scan first.',
        );
      return data.discovery;
    };
    const batch = createEvmDiscoveryBatch({
      unavailable: () =>
        wallet.archived
          ? 'Wallet archived.'
          : document.visibilityState !== 'visible'
            ? 'Tab hidden. Restart explicitly to continue.'
            : !navigator.onLine
              ? 'Browser offline. Restart explicitly to continue.'
              : null,
      read: async (signal) => {
        const scan = await request(signal);
        if (!scan) throw new Error('No saved discovery.');
        return scan;
      },
      advance: (scan, signal) => request(signal, scan),
      onScan,
      onState: (next) => {
        setState(next);
        onActive(next.status === 'reading' || next.status === 'waiting');
      },
    });
    driver.current = batch;
    const availability = () => batch.availabilityChanged();
    document.addEventListener('visibilitychange', availability);
    window.addEventListener('offline', availability);
    return () => {
      batch.destroy();
      driver.current = null;
      onActive(false);
      document.removeEventListener('visibilitychange', availability);
      window.removeEventListener('offline', availability);
    };
  }, [
    wallet.address,
    wallet.network,
    wallet.updatedAt,
    wallet.archived,
    onScan,
    onActive,
  ]);
  const active = state.status === 'reading' || state.status === 'waiting';
  return (
    <section aria-label="Automatic older EVM discovery">
      <Button
        disabled={disabled || active || wallet.archived}
        onClick={() => driver.current?.start()}
      >
        Scan remaining older blocks
      </Button>
      <Button
        disabled={!active}
        variant="outline"
        onClick={() => driver.current?.stop()}
      >
        Stop automatic discovery
      </Button>
      <p>
        Continues the saved scan one page at a time, with 15 seconds between
        reads, up to 200 blocks and 100 matches. Hiding this tab, going offline
        or leaving this wallet stops the driver. Restart explicitly to continue.
        Completed pages remain saved. No background scheduler.
      </p>
      <output>
        Automatic discovery: {state.status}
        {state.pages > 0 ? ` · ${state.pages} saved pages.` : '.'}{' '}
        {state.reason}
      </output>
    </section>
  );
}
