/** @vitest-environment jsdom */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
const registry = vi.hoisted(() => ({
  wallets: [] as unknown[],
  get: vi.fn(),
  on: vi.fn(() => () => {}),
}));
vi.mock('@wallet-standard/app', () => ({
  getWallets: () => ({ get: () => registry.wallets, on: registry.on }),
}));
import { WalletLogin } from './wallet-login';
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  registry.wallets = [];
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
async function mount() {
  const onError = vi.fn(),
    setBusy = vi.fn();
  const element = document.createElement('div');
  document.body.appendChild(element);
  const root = createRoot(element);
  await act(async () =>
    root.render(
      <WalletLogin busy={false} setBusy={setBusy} onError={onError} />,
    ),
  );
  await act(async () => element.querySelector('button')!.click());
  return { root, element, onError, setBusy };
}
it('explains the missing wallet without asking for secrets or a transaction', async () => {
  const f = await mount();
  expect(f.element.textContent).toContain('No compatible wallet detected');
  expect(f.element.textContent).toContain('No transaction or network fee');
  await act(async () => f.root.unmount());
});
function wallet(sign: ReturnType<typeof vi.fn>) {
  const account = {
    address: 'test-wallet',
    chains: ['solana:mainnet'],
    features: ['solana:signMessage'],
  };
  const item = {
    name: 'Test wallet',
    chains: ['solana:mainnet'],
    accounts: [account],
    features: {
      'standard:connect': {
        connect: vi.fn(async () => ({ accounts: [account] })),
      },
      'solana:signMessage': { signMessage: sign },
    },
  };
  registry.wallets = [item];
  return item;
}
it('recovers after wallet cancellation and sends no verification request', async () => {
  const sign = vi.fn().mockRejectedValue(new Error('User rejected request')),
    item = wallet(sign);
  const nonce = 'a'.repeat(64),
    message = `${window.location.host} wants you to sign in with your Solana account:\ntest-wallet\n\nSign in to Bundle Tek. This does not authorize transactions.\n\nURI: ${window.location.origin}\nVersion: 1\nChain ID: solana:mainnet\nNonce: ${nonce}\nIssued At: now`;
  const fetcher = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ nonce, message }) });
  vi.stubGlobal('fetch', fetcher);
  const f = await mount();
  await act(async () =>
    Array.from(f.element.querySelectorAll('button'))
      .find((b) => b.textContent === item.name)!
      .click(),
  );
  expect(sign).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(f.onError).toHaveBeenLastCalledWith(
    'Wallet sign-in cancelled or unavailable. Please try again.',
  );
  expect(f.setBusy).toHaveBeenLastCalledWith(false);
  await act(async () => f.root.unmount());
});
it('never asks the wallet to sign a challenge for another site', async () => {
  const sign = vi.fn();
  wallet(sign);
  const fetcher = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      json: async () => ({
        nonce: 'a'.repeat(64),
        message: 'evil.example wants you to sign in',
      }),
    });
  vi.stubGlobal('fetch', fetcher);
  const f = await mount();
  await act(async () =>
    Array.from(f.element.querySelectorAll('button'))
      .find((b) => b.textContent === 'Test wallet')!
      .click(),
  );
  expect(sign).not.toHaveBeenCalled();
  expect(f.onError).toHaveBeenLastCalledWith('Invalid sign-in message.');
  await act(async () => f.root.unmount());
});
it('stops if the connected account changes while requesting a challenge', async () => {
  const sign = vi.fn(),
    item = wallet(sign);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      item.accounts = [];
      return {
        ok: true,
        json: async () => ({ nonce: 'a'.repeat(64), message: 'unused' }),
      };
    }),
  );
  const f = await mount();
  await act(async () =>
    Array.from(f.element.querySelectorAll('button'))
      .find((b) => b.textContent === 'Test wallet')!
      .click(),
  );
  expect(sign).not.toHaveBeenCalled();
  expect(f.onError).toHaveBeenLastCalledWith(
    'Wallet changed. Please sign in again.',
  );
  await act(async () => f.root.unmount());
});
