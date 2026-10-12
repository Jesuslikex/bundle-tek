'use client';
import { useEffect, useState } from 'react';
import type { WalletOperation } from '@/lib/wallet-operation';
export function useWalletOperations(wallet: string | null) {
  const [revision, setRevision] = useState(0),
    identity = `${wallet}\n${revision}`;
  const [state, setState] = useState({
    identity: '',
    active: null as WalletOperation | null,
    error: '',
    loading: true,
  });
  useEffect(() => {
    const controller = new AbortController();
    if (wallet)
      void (async () => {
        try {
          const response = await fetch(
            `/api/wallet/operations?address=${encodeURIComponent(wallet)}`,
            { cache: 'no-store', signal: controller.signal },
          );
          const data = (await response.json()) as {
            active?: WalletOperation | null;
            error?: string;
          };
          if (!response.ok || data.active === undefined)
            throw new Error(
              data.error || 'Pending wallet operation unavailable.',
            );
          if (!controller.signal.aborted)
            setState({
              identity,
              active: data.active,
              error: '',
              loading: false,
            });
        } catch (e) {
          if (!controller.signal.aborted)
            setState({
              identity,
              active: null,
              error:
                e instanceof Error
                  ? e.message
                  : 'Pending wallet operation unavailable.',
              loading: false,
            });
        }
      })();
    return () => controller.abort();
  }, [wallet, identity]);
  const current = !!wallet && state.identity === identity;
  return {
    active: current ? state.active : null,
    error: current ? state.error : '',
    loading: !!wallet && (!current || state.loading),
    ready: current && !state.loading && !state.error,
    refresh: () => setRevision((value) => value + 1),
  };
}
