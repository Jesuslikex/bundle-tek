'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { EvmChain } from '@/lib/evm-network';
import { validateOwnershipChallenge } from '@/lib/wallet-ownership-message';
import {
  connectEvmWallet,
  signOwnershipMessage,
  walletError,
  type BrowserWalletProvider,
} from '@/lib/evm-wallet';

type WalletOption = {
  id: string;
  name: string;
  provider: BrowserWalletProvider;
};
type Connection = WalletOption & { address: string };
export function EvmWalletConnection({
  chain,
  savedAddresses,
  disabled,
  onSaveAddress,
  onVerified,
}: {
  chain: EvmChain;
  savedAddresses: string[];
  disabled: boolean;
  onSaveAddress: (address: string) => void;
  onVerified: () => Promise<void>;
}) {
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [choice, setChoice] = useState('');
  const [connection, setConnection] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const version = useRef(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    let disposed = false;
    const cancelPending = () => {
      version.current++;
      request.current?.abort();
    };
    function announce(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (
        !detail?.info ||
        typeof detail.provider?.request !== 'function' ||
        typeof detail.info.uuid !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          detail.info.uuid,
        ) ||
        typeof detail.info.name !== 'string' ||
        !detail.info.name.trim() ||
        detail.info.name.length > 60
      )
        return;
      // Self-reported names are text only. Do not load wallet-provided icons or trust rdns.
      setWallets((current) =>
        current.some(
          (w) => w.id === detail.info.uuid || w.provider === detail.provider,
        )
          ? current
          : [
              ...current.filter(
                (w) => w.id !== 'legacy' || w.provider !== detail.provider,
              ),
              {
                id: detail.info.uuid,
                name: detail.info.name,
                provider: detail.provider,
              },
            ],
      );
    }
    window.addEventListener('eip6963:announceProvider', announce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    const legacy = (window as Window & { ethereum?: BrowserWalletProvider })
      .ethereum;
    queueMicrotask(() => {
      if (!disposed && typeof legacy?.request === 'function')
        setWallets((current) =>
          current.some((w) => w.provider === legacy)
            ? current
            : [
                ...current,
                { id: 'legacy', name: 'Browser wallet', provider: legacy },
              ],
        );
    });
    return () => {
      disposed = true;
      window.removeEventListener('eip6963:announceProvider', announce);
      cancelPending();
    };
  }, []);
  useEffect(() => {
    if (!connection) return;
    const provider = connection.provider;
    function changed() {
      version.current++;
      request.current?.abort();
      setConnection(null);
      setBusy(false);
      setNotice('');
      setError('Wallet account or network changed. Connect again.');
    }
    const events = ['accountsChanged', 'chainChanged', 'disconnect'];
    events.forEach((event) => provider.on?.(event, changed));
    return () =>
      events.forEach((event) => provider.removeListener?.(event, changed));
  }, [connection]);
  const selected = wallets.find((w) => w.id === choice) ?? wallets[0];
  const saved = !!connection && savedAddresses.includes(connection.address);
  async function connect() {
    if (!selected || busy || disabled) return;
    const attempt = ++version.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const address = await connectEvmWallet(
        selected.provider,
        chain,
        () => version.current === attempt,
      );
      if (version.current === attempt) setConnection({ ...selected, address });
    } catch (e) {
      if (version.current === attempt) setError(walletError(e));
    } finally {
      if (version.current === attempt) setBusy(false);
    }
  }
  async function verify() {
    if (!connection || !saved || busy || disabled) return;
    const attempt = ++version.current;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    setNotice('Requesting an ownership message…');
    async function post(body: Record<string, unknown>) {
      const response = await fetch('/api/wallet-workspace/ownership', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ chain, address: connection!.address, ...body }),
      });
      const value = (await response.json()) as Record<string, unknown>;
      if (!response.ok)
        throw new Error(
          typeof value.error === 'string'
            ? value.error
            : 'Verification unavailable.',
        );
      return value;
    }
    try {
      const challenge = await post({ action: 'challenge' });
      if (version.current !== attempt) return;
      const validated = validateOwnershipChallenge(
        challenge,
        window.location.origin,
        chain,
        connection.address,
      );
      setNotice('Review the ownership message in your wallet.');
      const signature = await signOwnershipMessage(
        connection.provider,
        chain,
        connection.address,
        validated.message,
        () => version.current === attempt,
      );
      if (version.current !== attempt) return;
      await post({ action: 'verify', id: validated.id, signature });
      if (version.current !== attempt) return;
      await onVerified();
      if (version.current === attempt)
        setNotice(
          'Message signature verified. The verification time is recorded in your roster.',
        );
    } catch (e) {
      if (version.current === attempt) {
        setNotice('');
        setError(walletError(e));
      }
    } finally {
      if (version.current === attempt) setBusy(false);
    }
  }
  return (
    <div className="evm-wallet-connector">
      <div>
        <h3>Connect your {chain} wallet</h3>
        <p>
          Use an external wallet to add your account and verify its message
          signature. Verification uses no gas. Smart contract wallets are not
          supported yet.
        </p>
      </div>
      {connection ? (
        <>
          <div className="evm-connected-account">
            <strong>
              {connection.name} · {chain}
            </strong>
            <code>{connection.address}</code>
          </div>
          <div className="evm-wallet-actions">
            {saved ? (
              <Button disabled={busy || disabled} onClick={() => void verify()}>
                Verify ownership
              </Button>
            ) : (
              <Button
                disabled={busy || disabled}
                onClick={() => onSaveAddress(connection.address)}
              >
                Add connected account to folder
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => {
                version.current++;
                request.current?.abort();
                setConnection(null);
                setBusy(false);
                setNotice('');
                setError('');
              }}
            >
              Disconnect
            </Button>
          </div>
          <p>
            Ownership verification records a signature at a point in time.
            Launching and funding require separate approvals in your wallet.
          </p>
        </>
      ) : wallets.length ? (
        <div className="evm-wallet-actions">
          <label>
            Browser wallet
            <select
              aria-label="Browser wallet"
              disabled={busy || disabled}
              value={selected?.id ?? ''}
              onChange={(e) => setChoice(e.target.value)}
            >
              {wallets.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <Button disabled={busy || disabled} onClick={() => void connect()}>
            {busy ? 'Connecting…' : 'Connect wallet'}
          </Button>
        </div>
      ) : (
        <div className="evm-wallet-actions">
          <p>No compatible browser wallet detected.</p>
          <Button
            variant="outline"
            onClick={() =>
              window.dispatchEvent(new Event('eip6963:requestProvider'))
            }
          >
            Refresh wallet discovery
          </Button>
        </div>
      )}
      {busy && connection ? (
        <output>{notice || 'Verifying ownership…'}</output>
      ) : notice ? (
        <output>{notice}</output>
      ) : null}
      {error ? (
        <p className="wallet-workspace-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
