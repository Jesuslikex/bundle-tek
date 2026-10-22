// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WalletWorkspace } from './wallet-workspace';
import bs58 from 'bs58';
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
it('mounts the selected-wallet funding check and exact gap badges in the real wallet table', async () => {
  const second = bs58.encode(new Uint8Array(32).fill(2));
  const wallets = [
    workspace.wallets[0],
    { ...workspace.wallets[0], address: second },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!url.endsWith('/funding-times'))
        return Response.json({ ...workspace, wallets });
      return Response.json({
        format: 'wallet-funding-times-v1',
        network: 'mainnet',
        scope: 'most-recently-saved-native-transfer',
        capturedAt: '2026-10-22T00:00:00.000Z',
        executionAllowed: false,
        wallets: wallets.map((w, i) => ({
          address: w.address,
          revision: w.revision,
          reason: null,
          funding: {
            signature: bs58.encode(new Uint8Array(64).fill(i + 1)),
            slot: 1,
            blockTime: 100000 + i * 1474,
          },
        })),
      });
    }),
  );
  await act(async () => root.render(<WalletWorkspace onFunding={vi.fn()} />));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.querySelectorAll('tbody [data-wallet-selection]')).toHaveLength(
    2,
  );
  for (const checkbox of host.querySelectorAll<HTMLInputElement>(
    'tbody [data-wallet-selection]',
  ))
    await act(async () => checkbox.click());
  expect(host.textContent).toContain('2 selected across pages');
  const check = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === 'Check recorded funding times',
  )!;
  expect(check).toBeTruthy();
  await act(async () => check.click());
  expect(
    [...host.querySelectorAll('tbody summary')].filter(
      (s) => s.textContent === '24m 34s apart',
    ),
  ).toHaveLength(2);
});
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

it('pages a large roster while preserving explicit selections and the 100-wallet action cap', async () => {
  const wallets = Array.from({ length: 110 }, (_, index) => ({
    ...workspace.wallets[0],
    address: 'wallet-' + String(index).padStart(3, '0'),
    label: 'Wallet ' + index,
  }));
  vi.mocked(fetch).mockImplementation(() =>
    Promise.resolve(Response.json({ ...workspace, wallets })),
  );
  await act(async () => root.render(<WalletWorkspace onFunding={vi.fn()} />));
  const rows = () => host.querySelectorAll('tbody tr');
  const click = async (text: string) =>
    act(async () => {
      const button = [...host.querySelectorAll('button')].find(
        (b) => b.textContent === text,
      );
      expect(button).toBeDefined();
      button!.click();
    });
  const selectPage = async () =>
    act(async () =>
      host
        .querySelector<HTMLInputElement>(
          '[aria-label="Select visible wallets"]',
        )!
        .click(),
    );
  expect(rows()).toHaveLength(50);
  expect(host.textContent).toContain('110 matching wallets');
  expect(
    [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Refresh page balances',
    )?.disabled,
  ).toBe(false);
  await selectPage();
  expect(host.textContent).toContain('50 selected across pages');
  await click('Next wallet page');
  expect(rows()[0].textContent).toContain('Wallet 50');
  await selectPage();
  expect(host.textContent).toContain('100 selected across pages');
  await click('Next wallet page');
  expect(rows()).toHaveLength(10);
  expect(
    host.querySelector<HTMLInputElement>(
      '[aria-label="Select visible wallets"]',
    )!.disabled,
  ).toBe(true);
  await click('Previous wallet page');
  await selectPage();
  expect(host.textContent).toContain('50 selected across pages');
  await click('Clear wallet selection');
  expect(host.textContent).not.toContain('selected across pages');
  expect(
    vi.mocked(fetch).mock.calls.every((call) => call[1]?.method !== 'POST'),
  ).toBe(true);
  await act(async () => state.vault!.onOpenWarmup!(wallets[109].address));
  expect(host.textContent).toContain('page 3 of 3');
  expect(rows()).toHaveLength(10);
  expect(host.querySelector('[data-testid="warmup"]')?.textContent).toContain(
    wallets[109].address,
  );
});
