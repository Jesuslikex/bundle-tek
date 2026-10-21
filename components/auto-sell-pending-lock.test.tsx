// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutoSell } from './auto-sell-modal';
import type { AutoSellObservedTrade } from '@/lib/auto-sell';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
const mocks = vi.hoisted(() => ({
  trades: [] as AutoSellObservedTrade[],
  read: vi.fn(),
  unlock: vi.fn(),
  sell: vi.fn(),
}));
vi.mock('@/lib/browser-wallet-vault', () => ({
  VAULT_STORAGE_KEY: 'synthetic-pending-lock-no-keys',
  unlockVault: mocks.unlock,
}));
vi.mock('@/lib/auto-sell-feed', () => ({
  createAutoSellFeed: () => mocks.read,
}));
vi.mock('@/lib/auto-sell-execute', () => ({
  createAutoSellExecutor: () => mocks.sell,
}));
const wallet = '11111111111111111111111111111111';
const project = {
  id: 'synthetic-pending-project',
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
    address: wallet,
    chain: 'Solana',
    revision: 1,
    archived: false,
    label: 'Synthetic wallet',
  },
] as WorkspaceWallet[];
let host: HTMLDivElement, root: Root | null;
let finish: (value: {
  soldRaw: bigint;
  wallet: string;
  signature: string;
}) => void;
let refuse: (error: Error) => void;
let held: Set<string>, releases: string[];
const priorLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T00:00:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No external requests in this fixture.');
    }),
  );
  mocks.trades = [];
  mocks.read.mockImplementation(async () => mocks.trades);
  mocks.unlock.mockImplementation(async () => ({
    payload: { wallets: [{ family: 'solana', address: wallet }] },
  }));
  mocks.sell.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        finish = resolve;
        refuse = reject;
      }),
  );
  held = new Set();
  releases = [];
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: vi.fn(
        async (
          name: string,
          _options: unknown,
          callback: (lock: object | null) => unknown,
        ) => {
          if (held.has(name)) return callback(null);
          held.add(name);
          try {
            return await callback({ name });
          } finally {
            held.delete(name);
            releases.push(name);
          }
        },
      ),
    },
  });
  localStorage.setItem('synthetic-pending-lock-no-keys', 'NO VAULT');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host.remove();
  localStorage.clear();
  if (priorLocks) Object.defineProperty(navigator, 'locks', priorLocks);
  else Reflect.deleteProperty(navigator, 'locks');
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
async function fill(selector: string, value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>(selector)!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function configure() {
  await click('Auto Sell');
  await fill('input[id$="-rep"]', '50');
  await fill('input[type="password"]', 'SYNTHETIC');
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
}
async function pendingSell(durationSeconds?: string) {
  await act(async () =>
    root!.render(
      <AutoSell project={project} wallets={wallets} locked={false} />,
    ),
  );
  await configure();
  if (durationSeconds)
    await fill('input[aria-label="Session duration seconds"]', durationSeconds);
  await click('Run 1 Strategy');
  mocks.trades = [
    {
      id: 'synthetic-buy',
      sender: 'OUTSIDE',
      side: 'Buy',
      tokenAmount: '10',
      quoteAmount: '1',
      priceUsd: '1',
      timestamp: new Date().toISOString(),
    },
  ];
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(mocks.sell).toHaveBeenCalledOnce();
  expect(held.size).toBe(1);
}
it.each(['project', 'wallet', 'locked', 'unmount'] as const)(
  'retains the old run lock across %s teardown until its original pending operation settles',
  async (change) => {
    await pendingSell();
    const session = await mocks.unlock.mock.results[0].value;
    const nextProject =
      change === 'project' ? { ...project, revision: 2 } : project;
    const nextWallets =
      change === 'wallet'
        ? wallets.map((w) => ({ ...w, revision: 2 }))
        : wallets;
    if (change === 'unmount') {
      await act(async () => root!.unmount());
      root = createRoot(host);
    }
    await act(async () =>
      root!.render(
        <AutoSell
          project={nextProject}
          wallets={nextWallets}
          locked={change === 'locked'}
        />,
      ),
    );
    if (change === 'locked')
      await act(async () =>
        root!.render(
          <AutoSell
            project={nextProject}
            wallets={nextWallets}
            locked={false}
          />,
        ),
      );
    expect(session.payload.wallets).toEqual([]);
    expect(mocks.sell.mock.calls[0][1].aborted).toBe(true);
    expect(releases).toEqual([]);
    await configure();
    await click('Run 1 Strategy');
    expect(host.textContent).toContain('active or still settling');
    expect(mocks.unlock).toHaveBeenCalledOnce();
    expect(mocks.sell).toHaveBeenCalledOnce();
    mocks.trades = [];
    await act(async () =>
      finish({ soldRaw: 5n, wallet, signature: 'synthetic-only-no-send' }),
    );
    expect(held.size).toBe(0);
    expect(releases).toHaveLength(1);
    await click('Run 1 Strategy');
    expect(mocks.unlock).toHaveBeenCalledTimes(2);
    expect(held.size).toBe(1);
    expect(mocks.sell).toHaveBeenCalledOnce();
    await click('Stop');
    expect(releases).toHaveLength(2);
  },
);
it.each(['Stop', 'pagehide'] as const)(
  'keeps the lock after %s until a held rejection settles, then releases it once',
  async (change) => {
    await pendingSell();
    if (change === 'Stop') await click('Stop');
    else await act(async () => window.dispatchEvent(new Event('pagehide')));
    expect(releases).toEqual([]);
    expect(host.textContent).toContain('Wait for the pending sell');
    await act(async () =>
      refuse(
        Object.assign(Error('Synthetic possibly submitted outcome'), {
          uncertain: true,
        }),
      ),
    );
    expect(releases).toHaveLength(1);
    expect(held.size).toBe(0);
    expect(host.textContent).toContain('Synthetic possibly submitted outcome');
    expect(host.textContent).toContain('Accounted tokens5');
    expect(mocks.sell).toHaveBeenCalledOnce();
    await act(async () => window.dispatchEvent(new Event('pagehide')));
    expect(releases).toHaveLength(1);
  },
);

it.each(['ordinary', 'uncertain', 'stop-then-unmount', 'session-end'] as const)(
  'releases once after %s settles following teardown without mutating unmounted React state',
  async (kind) => {
    await pendingSell(kind === 'session-end' ? '8' : undefined);
    if (kind === 'stop-then-unmount') await click('Stop');
    if (kind === 'session-end') {
      await act(async () => vi.advanceTimersByTimeAsync(4000));
      expect(host.textContent).not.toContain('Running while this tab is open');
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await act(async () => root!.unmount());
      root = null;
      expect(releases).toEqual([]);
      await act(async () =>
        refuse(
          Object.assign(
            Error('Synthetic held rejection'),
            kind === 'uncertain' ? { uncertain: true } : { name: 'AbortError' },
          ),
        ),
      );
      expect(releases).toHaveLength(1);
      expect(held.size).toBe(0);
      expect(errors).not.toHaveBeenCalled();
      expect(mocks.sell).toHaveBeenCalledOnce();
    } finally {
      errors.mockRestore();
    }
  },
);
it('releases the original lock and clears a late vault unlock after teardown without starting a runner', async () => {
  let unlock!: (session: unknown) => void;
  mocks.unlock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        unlock = resolve;
      }),
  );
  await act(async () =>
    root!.render(
      <AutoSell project={project} wallets={wallets} locked={false} />,
    ),
  );
  await configure();
  await click('Run 1 Strategy');
  expect(held.size).toBe(1);
  await act(async () => root!.unmount());
  root = null;
  expect(releases).toEqual([]);
  const session = {
    payload: { wallets: [{ family: 'solana', address: wallet }] },
  };
  await act(async () => unlock(session));
  expect(session.payload.wallets).toEqual([]);
  expect(held.size).toBe(0);
  expect(releases).toHaveLength(1);
  expect(mocks.sell).not.toHaveBeenCalled();
});
it('does not release a paused live session when its pending operation settles', async () => {
  await pendingSell();
  await click('Pause');
  expect(releases).toEqual([]);
  await act(async () =>
    finish({ soldRaw: 5n, wallet, signature: 'synthetic-only' }),
  );
  expect(held.size).toBe(1);
  expect(releases).toEqual([]);
  expect(host.textContent).toContain('Paused. Resume continues queued amounts');
  await click('Stop');
  expect(releases).toHaveLength(1);
});
