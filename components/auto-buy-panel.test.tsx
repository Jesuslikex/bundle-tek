// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  unlock: vi.fn(),
  trader: vi.fn(),
  feed: vi.fn(),
}));
vi.mock('@/lib/browser-wallet-vault', () => ({
  VAULT_STORAGE_KEY: 'vault',
  unlockVault: mocks.unlock,
}));
vi.mock('@/lib/auto-sell-feed', () => ({
  createAutoSellFeed: () => mocks.feed,
}));
vi.mock('@/lib/imported-trade-execute', async (orig) => ({
  ...(await orig<typeof import('@/lib/imported-trade-execute')>()),
  createRotatingTrader: (...args: unknown[]) => {
    mocks.trader.mock.calls.push(args);
    return async (lamports: bigint) => ({
      signature: 'sig',
      wallet: 'W111',
      lamports,
    });
  },
}));
import { AutoBuyPanel } from './auto-buy-panel';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const A = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';
const project = {
  id: 'p1',
  revision: 2,
  document: {
    token: {
      chain: 'Solana',
      address: 'Mint111',
      decimals: 6,
      symbol: 'TEK',
      totalSupplyRaw: '1000000000000000',
    },
  },
} as unknown as ImportedTokenProject;
const wallets = [
  {
    chain: 'Solana',
    address: A,
    folderId: 'f',
    label: 'one',
    role: 'Recipient',
    archived: false,
    revision: 1,
    updatedAt: '',
  },
] as WorkspaceWallet[];
const roots: { unmount(): void }[] = [];
beforeEach(() => {
  localStorage.setItem('vault', 'enc');
  mocks.unlock.mockResolvedValue({
    payload: { wallets: [{ family: 'solana', address: A }] },
  });
  mocks.feed.mockResolvedValue([]);
});
afterEach(() => {
  act(() => roots.splice(0).forEach((r) => r.unmount()));
  document.body.innerHTML = '';
  localStorage.clear();
  vi.clearAllMocks();
  mocks.trader.mock.calls.length = 0;
});
function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  Reflect.set(Object.getPrototypeOf(input), 'value', value, input);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const field = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('label')]
    .find((l) => l.textContent?.startsWith(label))!
    .querySelector('input')!;
async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  await act(async () =>
    root.render(
      <AutoBuyPanel project={project} wallets={wallets} locked={false} />,
    ),
  );
  return el;
}
const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === text)!;
it('refuses to run without a SOL budget', async () => {
  const el = await mount();
  await act(async () => button(el, 'Run Strategy').click());
  expect(el.querySelector('[role=alert]')?.textContent).toMatch(/budget/);
  expect(mocks.unlock).not.toHaveBeenCalled();
});
it('starts an opt-in run with the chosen wallets, then Stop ends it', async () => {
  const el = await mount();
  await act(async () => type(field(el, 'Total SOL budget'), '1'));
  await act(async () =>
    el.querySelector<HTMLInputElement>(`input[type=checkbox]`)!.click(),
  );
  await act(async () =>
    type(el.querySelector<HTMLInputElement>('input[type=password]')!, 'pw'),
  );
  await act(async () => button(el, 'Run Strategy').click());
  expect(mocks.unlock).toHaveBeenCalledWith('enc', 'pw');
  expect(mocks.trader.mock.calls[0][1]).toEqual([wallets[0]]);
  expect(
    (mocks.trader.mock.calls[0][0] as { slippageBps: number }).slippageBps,
  ).toBe(50);
  expect(el.textContent).toContain('running');
  await act(async () => button(el, 'Stop').click());
  expect(el.textContent).toContain('Stopped by you.');
  expect(button(el, 'Run Strategy')).toBeTruthy();
});
it('rejects slippage above 50 bps', async () => {
  const el = await mount();
  await act(async () => type(field(el, 'Total SOL budget'), '1'));
  await act(async () => type(field(el, 'Slippage'), '500'));
  await act(async () => button(el, 'Run Strategy').click());
  expect(el.querySelector('[role=alert]')?.textContent).toMatch(/50 bps/);
});
