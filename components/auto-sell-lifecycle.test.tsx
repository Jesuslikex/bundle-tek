// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutoSell } from './auto-sell-modal';
import { AutoSellRunner } from '@/lib/auto-sell-runner';
import { unlockVault, type VaultSession } from '@/lib/browser-wallet-vault';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
vi.mock('@/lib/browser-wallet-vault', () => ({
  VAULT_STORAGE_KEY: 'synthetic-auto-sell-vault',
  unlockVault: vi.fn(),
}));
vi.mock('@/lib/auto-sell-feed', () => ({
  createAutoSellFeed: () => async () => [],
}));
const address = '11111111111111111111111111111111';
const project = {
  id: 'synthetic-project',
  revision: 1,
  archived: false,
  document: {
    token: {
      chain: 'Solana',
      address: 'So11111111111111111111111111111111111111112',
      decimals: 6,
      totalSupplyRaw: '1000000000',
    },
  },
} as ImportedTokenProject;
const wallets = [
  {
    address,
    chain: 'Solana',
    revision: 1,
    archived: false,
    label: 'Synthetic sell wallet',
  },
] as WorkspaceWallet[];
let host: HTMLDivElement, root: Root | null;
beforeEach(() => {
  vi.mocked(unlockVault).mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.setItem('synthetic-auto-sell-vault', 'FIXTURE ONLY');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
async function startUnlock() {
  await act(async () =>
    root!.render(
      <AutoSell project={project} wallets={wallets} locked={false} />,
    ),
  );
  await click('Auto Sell');
  const replication = [...host.querySelectorAll('label')].find((x) =>
    x.textContent?.includes('Replication Factor'),
  )!;
  const replicationInput = document.getElementById(
    replication.htmlFor,
  ) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(replicationInput, '10');
    replicationInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const label = [...host.querySelectorAll('label')].find((x) =>
    x.textContent?.includes('Synthetic sell wallet'),
  )!;
  await act(async () =>
    label.querySelector<HTMLInputElement>('input')!.click(),
  );
  const password = host.querySelector<HTMLInputElement>(
    'input[type="password"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(password, 'SYNTHETIC PASSWORD');
    password.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Run 1 Strategy');
}
it('never starts a run when vault unlock completes after the component unmounts', async () => {
  let resolve!: (value: VaultSession) => void;
  vi.mocked(unlockVault).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const start = vi
    .spyOn(AutoSellRunner.prototype, 'start')
    .mockImplementation(() => {});
  await startUnlock();
  expect(unlockVault).toHaveBeenCalledTimes(1);
  await act(async () => root!.unmount());
  root = null;
  const session = {
    payload: { wallets: [{ family: 'solana', address }] },
  } as VaultSession;
  await act(async () => resolve(session));
  expect(start).not.toHaveBeenCalled();
  expect(session.payload.wallets).toEqual([]);
});

it.each(['pagehide', 'cancel', 'project', 'wallet', 'locked'] as const)(
  'discards a pending unlock after %s invalidates the review',
  async (change) => {
    let resolve!: (value: VaultSession) => void;
    vi.mocked(unlockVault).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const start = vi
      .spyOn(AutoSellRunner.prototype, 'start')
      .mockImplementation(() => {});
    await startUnlock();
    expect(unlockVault).toHaveBeenCalledTimes(1);
    if (change === 'pagehide') {
      await act(async () => window.dispatchEvent(new Event('pagehide')));
    } else if (change === 'cancel') {
      await click('Cancel unlock');
    } else {
      await act(async () =>
        root!.render(
          <AutoSell
            project={
              change === 'project' ? { ...project, revision: 2 } : project
            }
            wallets={
              change === 'wallet'
                ? wallets.map((w) => ({ ...w, revision: 2 }))
                : wallets
            }
            locked={change === 'locked'}
          />,
        ),
      );
    }
    const session = {
      payload: { wallets: [{ family: 'solana', address }] },
    } as VaultSession;
    await act(async () => resolve(session));
    expect(start).not.toHaveBeenCalled();
    expect(session.payload.wallets).toEqual([]);
  },
);

it('starts only the currently approved run and erases the session on Stop', async () => {
  const session = {
    payload: { wallets: [{ family: 'solana', address }] },
  } as VaultSession;
  vi.mocked(unlockVault).mockResolvedValueOnce(session);
  const start = vi.spyOn(AutoSellRunner.prototype, 'start');
  await startUnlock();
  expect(start).toHaveBeenCalledOnce();
  await click('Stop');
  expect(host.textContent).toContain('Stopped by you.');
  expect(session.payload.wallets).toEqual([]);
});
