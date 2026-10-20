'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { LaunchChain } from '@/lib/launch-plan';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';

const storageKey = (chain: LaunchChain) => `bundle:funder:${chain}`;

function readStored(chain: LaunchChain) {
  try {
    return window.localStorage.getItem(storageKey(chain)) ?? '';
  } catch {
    return '';
  }
}

const CHANGE_EVENT = 'bundle:funder-change';

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/** The saved wallet the user picked as funder for this chain, or ''. */
export function useFunderAddress(chain: LaunchChain) {
  return useSyncExternalStore(
    subscribe,
    () => readStored(chain),
    () => '',
  );
}

function short(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

type State =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'error' }
  | { status: 'ready'; wallets: WorkspaceWallet[] };

/**
 * Sidebar "Funder" picker, as in Proxima. It only remembers which saved wallet
 * the user treats as their funder; it never signs or moves funds.
 */
export function SidebarFunder({
  chain,
  onOpenWallets,
}: {
  chain: LaunchChain;
  onOpenWallets: () => void;
}) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const picked = useFunderAddress(chain);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/wallet-workspace', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 401) return setState({ status: 'signed-out' });
        const data = (await response.json().catch(() => null)) as {
          wallets?: WorkspaceWallet[];
        } | null;
        if (!response.ok || !Array.isArray(data?.wallets))
          return setState({ status: 'error' });
        setState({ status: 'ready', wallets: data.wallets });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });
    return () => controller.abort();
  }, []);

  const wallets =
    state.status === 'ready'
      ? state.wallets.filter((w) => w.chain === chain && !w.archived)
      : [];

  function choose(address: string) {
    try {
      if (address) window.localStorage.setItem(storageKey(chain), address);
      else window.localStorage.removeItem(storageKey(chain));
    } catch {
      // Storage can be blocked; nothing else depends on this choice yet.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  return (
    <div className="sidebar-funder">
      <label htmlFor="sidebar-funder-select">Funder</label>
      {state.status === 'ready' && wallets.length > 0 ? (
        <select
          id="sidebar-funder-select"
          value={wallets.some((w) => w.address === picked) ? picked : ''}
          onChange={(e) => choose(e.target.value)}
        >
          <option value="">Select funder</option>
          {wallets.map((w) => (
            <option key={w.address} value={w.address}>
              {w.label ? `${w.label} · ${short(w.address)}` : short(w.address)}
            </option>
          ))}
        </select>
      ) : (
        <button
          id="sidebar-funder-select"
          type="button"
          className="sidebar-funder-empty"
          onClick={onOpenWallets}
        >
          {state.status === 'loading'
            ? 'Loading wallets…'
            : state.status === 'signed-out'
              ? 'Sign in to pick a funder'
              : state.status === 'error'
                ? 'Wallets unavailable'
                : `Add a ${chain} wallet`}
        </button>
      )}
    </div>
  );
}
