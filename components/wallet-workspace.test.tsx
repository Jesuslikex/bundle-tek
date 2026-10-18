// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WalletWorkspace } from './wallet-workspace';
import type { BrowserWalletVault } from './browser-wallet-vault';
const state = vi.hoisted(() => ({
  vault: null as ComponentProps<typeof BrowserWalletVault> | null,
}));
vi.mock('./browser-wallet-vault', () => ({
  BrowserWalletVault: (props: ComponentProps<typeof BrowserWalletVault>) => {
    state.vault = props;
    return <div>Vault fixture</div>;
  },
}));
vi.mock('./wallet-warmup', () => ({
  WalletWarmup: ({
    addresses,
    initialPlan,
  }: {
    addresses: string[];
    initialPlan: unknown;
  }) => (
    <div data-testid="warmup">{JSON.stringify({ addresses, initialPlan })}</div>
  ),
}));
vi.mock('./wallet-console', () => ({ WalletConsole: () => null }));
vi.mock('./wallet-holdings-panel', () => ({ WalletHoldingsPanel: () => null }));
vi.mock('./evm-holdings-panel', () => ({ EvmHoldingsPanel: () => null }));
vi.mock('./token-tools-panel', () => ({ TokenToolsPanel: () => null }));
vi.mock('./native-withdrawal-panel', () => ({
  NativeWithdrawalPanel: () => null,
}));
vi.mock('./wallet-cleanup-panel', () => ({ WalletCleanupPanel: () => null }));
vi.mock('./creator-fee-claim-panel', () => ({
  CreatorFeeClaimPanel: () => null,
}));
vi.mock('./evm-wallet-connection', () => ({ EvmWalletConnection: () => null }));
const address = '11111111111111111111111111111111';
const workspace = {
  folders: [
    {
      id: 'other',
      name: 'Other folder',
      chain: 'Solana',
      archived: false,
      revision: 1,
      updatedAt: '',
    },
  ],
  wallets: [
    {
      chain: 'Solana',
      address,
      folderId: '',
      label: '',
      role: 'Recipient',
      archived: false,
      revision: 1,
      updatedAt: '',
    },
  ],
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => Promise.resolve(Response.json(workspace))),
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it('opens exactly the created active wallet from an archived and searched view', async () => {
  await act(async () => root.render(<WalletWorkspace onFunding={vi.fn()} />));
  const archived = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'Archived wallets',
  )!;
  await act(async () => archived.click());
  const search = host.querySelector<HTMLInputElement>(
    '[aria-label="Search workspace wallets"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(search, 'hidden');
    search.dispatchEvent(new Event('input', { bubbles: true }));
    search.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.querySelector('[data-testid="warmup"]')).toBeNull();
  await act(async () => state.vault!.onOpenWarmup!(address));
  expect(host.querySelector('[data-testid="warmup"]')?.textContent).toBe(
    JSON.stringify({ addresses: [address], initialPlan: undefined }),
  );
  expect(search.value).toBe('');
  expect(
    [...host.querySelectorAll('button')].some(
      (button) => button.textContent === 'Archived wallets',
    ),
  ).toBe(true);
});
it('confirms an existing public address without another write and hands it to warmup', async () => {
  await act(async () => root.render(<WalletWorkspace onFunding={vi.fn()} />));
  let saved: boolean | void = false;
  await act(async () => {
    saved = await state.vault!.onAddPublic([address]);
  });
  expect(saved).toBe(true);
  expect(
    vi.mocked(fetch).mock.calls.every((call) => call[1]?.method !== 'POST'),
  ).toBe(true);
  await act(async () => state.vault!.onOpenWarmup!(address));
  expect(host.querySelector('[data-testid="warmup"]')?.textContent).toContain(
    address,
  );
});
it('clears a folder that does not contain the created wallet', async () => {
  await act(async () => root.render(<WalletWorkspace onFunding={vi.fn()} />));
  const folder = [
    ...host.querySelectorAll<HTMLButtonElement>('.wallet-folder-select'),
  ].find((button) => button.textContent?.includes('Other folder'))!;
  await act(async () => folder.click());
  expect(folder.getAttribute('aria-current')).toBe('page');
  await act(async () => state.vault!.onOpenWarmup!(address));
  expect(folder.getAttribute('aria-current')).toBeNull();
  expect(host.querySelector('[data-testid="warmup"]')?.textContent).toContain(
    address,
  );
});
