// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { nativeWithdrawalFixture } from '../test/native-withdrawal-fixture';
import { NativeWithdrawalPanel } from './native-withdrawal-panel';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import * as vaultModule from '@/lib/browser-wallet-vault';
import * as cacheModule from '@/lib/native-withdrawal-signature-cache';

const state = vi.hoisted(() => ({ wallets: [] as unknown[] }));
vi.mock('@wallet-standard/app', () => ({
  getWallets: () => ({ get: () => state.wallets, on: () => () => {} }),
}));

let root: Root, container: HTMLDivElement, unmounted: boolean;
const fetcher = vi.fn();
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset();
  state.wallets = [];
  unmounted = false;
  sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  if (!unmounted) act(() => root.unmount());
  container.remove();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = (name: string) => {
  const found = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(name),
  );
  if (!found) throw Error(`Missing button: ${name}`);
  return found;
};
const click = async (name: string) => act(async () => button(name).click());
async function until(text: string) {
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.textContent).toContain(text);
  });
}
async function fixture(external = true) {
  const f = await nativeWithdrawalFixture();
  const row = {
    id: f.review.id,
    wallet: f.wallet,
    walletRevision: f.review.walletRevision,
    document: f.review,
    state: 'awaiting_signature',
    signature: null as string | null,
    receipt: null,
    createdAt: f.review.preparedAt,
    updatedAt: f.review.preparedAt,
  };
  const account = {
    address: f.wallet,
    publicKey: bs58.decode(f.wallet),
    chains: ['solana:mainnet'],
    features: ['solana:signTransaction'],
  };
  let resolveWallet!: (result: { signedTransaction: Uint8Array }[]) => void;
  const sign = vi.fn(
    () =>
      new Promise<{ signedTransaction: Uint8Array }[]>((resolve) => {
        resolveWallet = resolve;
      }),
  );
  const feature = {
    version: '1.0.0',
    supportedTransactionVersions: ['legacy'],
    signTransaction: sign,
  };
  const wallet = {
    name: 'Fixture',
    chains: ['solana:mainnet'],
    accounts: [account],
    features: {
      'solana:signTransaction': feature,
      'standard:connect': {
        version: '1.0.0',
        connect: async () => ({ accounts: [account] }),
      },
      'standard:events': { version: '1.0.0', on: () => () => {} },
    },
  };
  state.wallets = [wallet];
  const posts: string[] = [];
  fetcher.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (!init?.method)
      return Response.json({
        withdrawals: [row],
        active: row,
        nextCursor: null,
      });
    const body = JSON.parse(init.body as string);
    posts.push(body.action);
    if (body.action === 'begin_signing') row.state = 'signing';
    else if (body.action === 'register') {
      row.state = 'signed';
      row.signature = f.signed.signature;
    } else throw Error(`Unexpected synthetic action ${body.action}`);
    return Response.json({ withdrawal: row });
  });
  const wallets = [
    { chain: 'Solana', address: f.wallet, label: 'Fixture', archived: false },
  ] as WorkspaceWallet[];
  await act(async () =>
    root.render(
      <NativeWithdrawalPanel
        wallets={wallets}
        initialWallet={f.wallet}
        initialOpen
      />,
    ),
  );
  await click('Reload withdrawal history');
  await until('Retained withdrawal');
  if (external) {
    const selects = [...container.querySelectorAll('select')];
    const signerSelect = selects.find((s) =>
      [...s.options].some((o) => o.value === 'external'),
    )!;
    await act(async () => {
      signerSelect.value = 'external';
      signerSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until('Wallet extension');
    const extension = [...container.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => o.value === 'Fixture'),
    )!;
    await act(async () => {
      extension.value = 'Fixture';
      extension.dispatchEvent(new Event('change', { bubbles: true }));
    });
  } else {
    const input = container.querySelector('input[type="password"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, 'fixture-password');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  const approval = [...container.querySelectorAll('label')]
    .find((l) => l.textContent?.includes('I approve this exact mainnet asset'))!
    .querySelector('input')!;
  await act(async () => approval.click());
  return {
    f,
    row,
    feature,
    wallet,
    sign,
    posts,
    resolve: () =>
      resolveWallet([
        {
          signedTransaction: Uint8Array.from(atob(f.signed.transaction), (c) =>
            c.charCodeAt(0),
          ),
        },
      ]),
  };
}
async function start(f: Awaited<ReturnType<typeof fixture>>) {
  await click('Approve and sign withdrawal');
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(f.sign).toHaveBeenCalledOnce();
  });
}
it('retains then registers after the external signer check succeeds', async () => {
  const f = await fixture();
  await start(f);
  expect(f.posts).toEqual(['begin_signing']);
  await act(async () => f.resolve());
  await until('Registered signature');
  expect(f.posts).toEqual(['begin_signing', 'register']);
});
it.each(['account', 'signer'] as const)(
  'retains without registering if the external %s changes during the prompt',
  async (changed) => {
    const f = await fixture();
    await start(f);
    if (changed === 'account')
      f.wallet.accounts = [{ ...f.wallet.accounts[0] }];
    else f.feature.signTransaction = vi.fn(async () => []);
    await act(async () => f.resolve());
    await until('An exact returned signature is retained in this tab');
    expect(f.posts).toEqual(['begin_signing']);
    expect(button('Register retained withdrawal signature').disabled).toBe(
      false,
    );
    expect(
      sessionStorage.getItem(
        `pulseforge.native-withdrawal-signature:${f.row.id}`,
      ),
    ).toBeTruthy();
  },
);
it('fails before reserving or prompting when tab storage is unavailable', async () => {
  const f = await fixture();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('unavailable');
  });
  await click('Approve and sign withdrawal');
  await until('Tab storage is unavailable');
  expect(f.posts).toEqual([]);
  expect(f.sign).not.toHaveBeenCalled();
});
it('keeps the returned signature in memory and refuses registration when storage fails after the prompt', async () => {
  const f = await fixture();
  await start(f);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('unavailable');
  });
  await act(async () => f.resolve());
  await until('Tab storage failed after signing');
  await until('An exact returned signature is retained in this tab');
  expect(f.posts).toEqual(['begin_signing']);
  expect(container.textContent).toContain('closing it may lose the signature');
});
it('retains a returned external signature in tab storage after the panel unmounts without registering', async () => {
  const f = await fixture();
  await start(f);
  act(() => root.unmount());
  unmounted = true;
  f.resolve();
  await vi.waitFor(() => {
    expect(
      sessionStorage.getItem(
        `pulseforge.native-withdrawal-signature:${f.row.id}`,
      ),
    ).toBeTruthy();
  });
  expect(f.posts).toEqual(['begin_signing']);
});
it('keeps the exact vault signature and never releases the reservation if approval expires after signing', async () => {
  const f = await fixture(false);
  vi.spyOn(vaultModule, 'unlockVault').mockResolvedValue(f.f.session);
  const retain = cacheModule.retainNativeWithdrawalSignature;
  vi.spyOn(cacheModule, 'retainNativeWithdrawalSignature').mockImplementation(
    async (...args) => {
      await retain(...args);
      vi.spyOn(Date, 'now').mockReturnValue(
        Date.parse(f.f.review.expiresAt) + 1,
      );
    },
  );
  await click('Approve and sign withdrawal');
  await until('An exact returned signature is retained in this tab');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
  });
  await until('This review has expired and cannot be registered');
  expect(f.posts).toEqual(['begin_signing']);
  expect(button('Register retained withdrawal signature').disabled).toBe(true);
  expect(container.querySelector('textarea')?.value).toBe(
    f.f.signed.transaction,
  );
  expect(container.textContent).toContain('Anyone with it may submit it');
});
it('keeps a vault signature in memory with a warning if tab storage and context fail after signing', async () => {
  const f = await fixture(false);
  vi.spyOn(vaultModule, 'unlockVault').mockResolvedValue(f.f.session);
  vi.spyOn(cacheModule, 'retainNativeWithdrawalSignature').mockImplementation(
    async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      throw Error('unavailable');
    },
  );
  await click('Approve and sign withdrawal');
  await until('An exact returned signature is retained in this tab');
  expect(container.textContent).toContain('Tab storage failed after signing');
  expect(container.querySelector('textarea')?.value).toBe(
    f.f.signed.transaction,
  );
  expect(f.posts).toEqual(['begin_signing']);
});
