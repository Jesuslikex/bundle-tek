'use client';
import { useEffect, useRef, useState } from 'react';
import { getWallets } from '@wallet-standard/app';
import bs58 from 'bs58';

type Wallet = ReturnType<ReturnType<typeof getWallets>['get']>[number];
type Account = Wallet['accounts'][number];
type Connect = { connect(): Promise<{ accounts: readonly Account[] }> };
type Sign = {
  signMessage(input: {
    account: Account;
    message: Uint8Array;
  }): Promise<readonly { signature: Uint8Array; signedMessage: Uint8Array }[]>;
};
async function post(path: string, data: object) {
  const response = await fetch(`/api/auth/solana/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error('Wallet sign-in failed. Please try again.');
  return response.json() as Promise<{
    nonce: string;
    message: string;
    success?: boolean;
  }>;
}
export function WalletLogin({
  busy,
  setBusy,
  onError,
}: {
  busy: boolean;
  setBusy: (value: boolean) => void;
  onError: (value: string) => void;
}) {
  const [wallets, setWallets] = useState<readonly Wallet[]>([]);
  const [open, setOpen] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const registry = getWallets();
    const refresh = () =>
      setWallets(
        registry
          .get()
          .filter(
            (wallet) =>
              wallet.chains.some((chain) => chain.startsWith('solana:')) &&
              wallet.features['standard:connect'] &&
              wallet.features['solana:signMessage'],
          ),
      );
    refresh();
    const unregister = registry.on('register', refresh),
      remove = registry.on('unregister', refresh);
    return () => {
      mounted.current = false;
      unregister();
      remove();
    };
  }, []);
  async function login(wallet: Wallet) {
    if (busy || pending.current) return;
    pending.current = true;
    setBusy(true);
    onError('');
    try {
      const connected = await (
        wallet.features['standard:connect'] as Connect
      ).connect();
      const account = connected.accounts.find(
        (item) =>
          item.chains.some((chain) => chain.startsWith('solana:')) &&
          item.features.includes('solana:signMessage'),
      );
      if (!account)
        throw new Error('This wallet does not support Solana message signing.');
      const assertCurrent = () => {
        if (
          !mounted.current ||
          !wallet.accounts.some((item) => item.address === account.address)
        )
          throw new Error('Wallet changed. Please sign in again.');
      };
      assertCurrent();
      const challenge = await post('challenge', { address: account.address });
      assertCurrent();
      const prefix = `${window.location.host} wants you to sign in with your Solana account:\n${account.address}\n\nSign in to Bundle Tek. This does not authorize transactions.\n\nURI: ${window.location.origin}\nVersion: 1\nChain ID: solana:mainnet\nNonce: ${challenge.nonce}\n`;
      if (
        !/^[a-f0-9]{64}$/.test(challenge.nonce) ||
        !challenge.message.startsWith(prefix) ||
        challenge.message.length > 1024
      )
        throw new Error('Invalid sign-in message.');
      const message = new TextEncoder().encode(challenge.message);
      const signed = await (
        wallet.features['solana:signMessage'] as Sign
      ).signMessage({ account, message });
      assertCurrent();
      if (
        signed.length !== 1 ||
        signed[0].signature.length !== 64 ||
        signed[0].signedMessage.length !== message.length ||
        !message.every((byte, index) => signed[0].signedMessage[index] === byte)
      )
        throw new Error('Wallet returned a different sign-in message.');
      const result = await post('verify', {
        address: account.address,
        nonce: challenge.nonce,
        signature: bs58.encode(signed[0].signature),
      });
      assertCurrent();
      if (!result.success) throw new Error('Wallet sign-in was not confirmed.');
      window.location.assign('/');
    } catch (error) {
      if (mounted.current)
        onError(
          error instanceof Error &&
            [
              'Wallet changed. Please sign in again.',
              'This wallet does not support Solana message signing.',
              'Invalid sign-in message.',
              'Wallet returned a different sign-in message.',
            ].includes(error.message)
            ? error.message
            : 'Wallet sign-in cancelled or unavailable. Please try again.',
        );
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        Continue with wallet
      </button>
      {open && (
        <div>
          <p>
            Approve a sign-in message in your Solana wallet. No transaction or
            network fee. Wallet accounts are separate from email accounts.
          </p>
          {wallets.length ? (
            wallets.map((wallet) => (
              <button
                type="button"
                key={wallet.name}
                disabled={busy}
                onClick={() => void login(wallet)}
              >
                {wallet.name}
              </button>
            ))
          ) : (
            <p>
              No compatible wallet detected. Open this page in a browser with a
              Solana wallet such as Phantom or Solflare.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
