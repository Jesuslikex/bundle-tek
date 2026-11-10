// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  balance: vi.fn(),
  unlock: vi.fn(),
}));
vi.mock('@/lib/browser-wallet-vault', () => ({
  VAULT_STORAGE_KEY: 'vault',
  unlockVault: mocks.unlock,
}));
vi.mock('@/lib/imported-trade-execute', async (orig) => ({
  ...(await orig<typeof import('@/lib/imported-trade-execute')>()),
  executeImportedTrade: mocks.execute,
  readGroupTokenBalances: mocks.balance,
}));
import { InstantTradePanel } from './instant-trade-panel';
import { USER_SETTINGS_KEY, defaultUserSettings } from '@/lib/user-settings';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const A = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';
const D = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const project = {
  id: 'p1',
  revision: 2,
  document: {
    token: { chain: 'Solana', address: 'Mint111', decimals: 6, symbol: 'TEK' },
  },
} as unknown as ImportedTokenProject;
const wallet = (address: string, role: string) =>
  ({
    chain: 'Solana',
    address,
    folderId: 'f',
    label: role,
    role,
    archived: false,
    revision: 1,
    updatedAt: '',
  }) as WorkspaceWallet;
const wallets = [wallet(A, 'Recipient'), wallet(D, 'Deployer')];
beforeEach(() => {
  localStorage.setItem('vault', 'enc');
  mocks.unlock.mockResolvedValue({
    payload: {
      wallets: wallets.map((w) => ({ family: 'solana', address: w.address })),
    },
  });
  mocks.execute.mockImplementation(async (_c, w, side, raw) => ({
    side,
    wallet: w.address,
    inputRaw: raw.toString(),
    signature: 'sig',
    preparationId: 'p',
  }));
  mocks.balance.mockResolvedValue({ [A]: 2000n, [D]: 2000n });
});
const roots: { unmount(): void }[] = [];
afterEach(() => {
  act(() => roots.splice(0).forEach((r) => r.unmount()));
  document.body.innerHTML = '';
  localStorage.clear();
  vi.clearAllMocks();
});
const byText = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith(text),
  )!;
async function setup(settings = defaultUserSettings()) {
  localStorage.setItem(USER_SETTINGS_KEY, JSON.stringify(settings));
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  await act(async () =>
    root.render(
      <InstantTradePanel project={project} wallets={wallets} locked={false} />,
    ),
  );
  await act(async () => byText(el, 'Instant Trade').click());
  await act(async () => byText(el, 'All').click());
  const pw = el.querySelector<HTMLInputElement>('input[type=password]')!;
  await act(async () => {
    Reflect.set(HTMLInputElement.prototype, 'value', 'pw', pw);
    pw.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => byText(el, 'Unlock').click());
  return el;
}
it('quick amounts only fill the field when Instant Trade is off', async () => {
  const el = await setup();
  await act(async () => byText(el, '0.25 SOL').click());
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(
    el.querySelector<HTMLInputElement>('input[inputmode=decimal]')!.value,
  ).toBe('0.25');
});
it('Instant Trade on: a quick buy signs one trade per selected wallet, after dev confirmation', async () => {
  const s = defaultUserSettings();
  s.tradePanel.instantTrade = true;
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const el = await setup(s);
  await act(async () => byText(el, '0.1 SOL').click());
  expect(confirm).toHaveBeenCalledOnce();
  expect(mocks.execute).toHaveBeenCalledTimes(2);
  expect(mocks.execute.mock.calls[0][2]).toBe('Buy');
  expect(mocks.execute.mock.calls[0][3]).toBe(100000000n);
});
it('declining the dev confirmation sends nothing', async () => {
  const s = defaultUserSettings();
  s.tradePanel.instantTrade = true;
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  const el = await setup(s);
  await act(async () => byText(el, '0.1 SOL').click());
  expect(mocks.execute).not.toHaveBeenCalled();
});
it('Space + key hotkey sells a percent of each fresh balance', async () => {
  const s = defaultUserSettings();
  s.hotkeys.enabled = true;
  s.tradePanel.confirmDevTrades = false;
  await setup(s);
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Space', key: ' ' }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyS', key: 's' }),
    );
  });
  expect(mocks.balance).toHaveBeenCalled();
  expect(mocks.execute).toHaveBeenCalledTimes(2);
  expect(mocks.execute.mock.calls[0][2]).toBe('Sell');
  expect(mocks.execute.mock.calls[0][3]).toBe(1000n);
});
it('hotkeys without Space do nothing', async () => {
  const s = defaultUserSettings();
  s.hotkeys.enabled = true;
  await setup(s);
  expect(mocks.execute).not.toHaveBeenCalled();
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyQ', key: 'q' }),
    ),
  );
  expect(mocks.execute).not.toHaveBeenCalled();
});
const setValue = async (el: HTMLElement, label: string, value: string) => {
  const input = el.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
  const select = input.tagName === 'SELECT';
  await act(async () => {
    Reflect.set(
      select ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
      'value',
      value,
      input,
    );
    input.dispatchEvent(
      new Event(select ? 'change' : 'input', { bubbles: true }),
    );
  });
};
const buyOf = async (el: HTMLElement, amount: string) => {
  const field = el.querySelector<HTMLInputElement>('input[inputmode=decimal]')!;
  await act(async () => {
    Reflect.set(HTMLInputElement.prototype, 'value', amount, field);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => byText(el, 'Buy with').click());
};
it('Dispersion with Low Tokens buys only with the emptiest wallet', async () => {
  const s = defaultUserSettings();
  s.tradePanel.confirmDevTrades = false;
  mocks.balance.mockResolvedValue({ [A]: 2000n, [D]: 5n });
  const el = await setup(s);
  await setValue(el, 'Dispersion', '1');
  await setValue(el, 'Wallet Selection', 'Low Tokens');
  await buyOf(el, '0.1');
  expect(mocks.balance).toHaveBeenCalled();
  expect(mocks.execute).toHaveBeenCalledOnce();
  expect(mocks.execute.mock.calls[0][1].address).toBe(D);
  expect(mocks.execute.mock.calls[0][3]).toBe(100000000n);
});
it('Random distribution keeps the total while varying each wallet', async () => {
  const s = defaultUserSettings();
  s.tradePanel.confirmDevTrades = false;
  const random = vi
    .spyOn(Math, 'random')
    .mockReturnValueOnce(0)
    .mockReturnValue(1);
  const el = await setup(s);
  await setValue(el, 'Amount Distribution', 'Random');
  await setValue(el, 'Deviation percent', '50');
  await buyOf(el, '0.1');
  random.mockRestore();
  const sizes = mocks.execute.mock.calls.map((c) => c[3] as bigint);
  expect(sizes).toEqual([50000000n, 150000000n]);
});
it('Weighted distribution needs saved SOL balances and sends nothing without them', async () => {
  const s = defaultUserSettings();
  s.tradePanel.confirmDevTrades = false;
  const el = await setup(s);
  await setValue(el, 'Amount Distribution', 'Weighted');
  await buyOf(el, '0.1');
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(el.querySelector('[role=alert]')!.textContent).toMatch(/SOL balances/);
});
it('an out-of-range dispersion is refused before any trade', async () => {
  const s = defaultUserSettings();
  s.tradePanel.confirmDevTrades = false;
  const el = await setup(s);
  await setValue(el, 'Dispersion', '3');
  await buyOf(el, '0.1');
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(el.querySelector('[role=alert]')!.textContent).toMatch(/1 to 2/);
});
