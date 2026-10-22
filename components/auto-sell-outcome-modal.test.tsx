// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AutoSell } from './auto-sell-modal';
import { installAutoSellBrowserLocks } from '../test/auto-sell-browser-lock-fixture';
import {
  autoSellOutcomePage,
  autoSellOutcomeReference as ref,
} from '../test/auto-sell-outcome-fixture';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import type { AutoSellObservedTrade } from '@/lib/auto-sell';
const mocks = vi.hoisted(() => ({
  feed: [] as AutoSellObservedTrade[],
  read: vi.fn(),
  unlock: vi.fn(),
  sell: vi.fn(),
}));
vi.mock('@/lib/browser-wallet-vault', () => ({
  VAULT_STORAGE_KEY: 'synthetic-outcome-modal-no-vault',
  unlockVault: mocks.unlock,
}));
vi.mock('@/lib/auto-sell-feed', () => ({
  createAutoSellFeed: () => mocks.read,
}));
vi.mock('@/lib/auto-sell-execute', () => ({
  createAutoSellExecutor: () => mocks.sell,
}));
it('keeps an open original-outcome lookup mounted when the actual modal appends a Pause log entry', async () => {
  const restoreLocks = installAutoSellBrowserLocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T00:00:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.feed = [];
  mocks.read.mockImplementation(async () => mocks.feed);
  mocks.unlock.mockResolvedValue({
    payload: { wallets: [{ family: 'solana', address: ref.wallet }] },
  });
  mocks.sell.mockRejectedValue(
    Object.assign(Error('Synthetic unknown outcome'), {
      uncertain: true,
      outcome: ref,
    }),
  );
  let finish!: (r: Response) => void;
  const fetcher = vi.fn(
    (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  localStorage.setItem('synthetic-outcome-modal-no-vault', 'SYNTHETIC');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const project = {
    id: ref.projectId,
    revision: ref.projectRevision,
    archived: false,
    document: {
      token: {
        chain: 'Solana',
        address: ref.mint,
        decimals: 6,
        totalSupplyRaw: '1000000000000',
      },
    },
  } as ImportedTokenProject;
  const wallets = [
    {
      address: ref.wallet,
      revision: ref.walletRevision,
      chain: 'Solana',
      archived: false,
      label: 'Synthetic wallet',
    },
  ] as WorkspaceWallet[];
  async function click(text: string) {
    const b = [...host.querySelectorAll('button')].find(
      (x) => x.textContent?.trim() === text,
    );
    expect(b).toBeTruthy();
    await act(async () => b!.click());
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
  try {
    await act(async () =>
      root.render(
        <AutoSell project={project} wallets={wallets} locked={false} />,
      ),
    );
    await click('Auto Sell');
    await fill('input[id$="-rep"]', '50');
    await fill('input[type="password"]', 'synthetic');
    await act(async () =>
      host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
    );
    await click('Run 1 Strategy');
    mocks.feed = [
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
    expect(mocks.sell).toHaveBeenCalledTimes(1);
    const reminders = [...host.querySelectorAll('details')].find(
      (e) =>
        e.querySelector('summary')?.textContent === 'Transaction reminders (1)',
    )!;
    expect(reminders).toBeTruthy();
    await act(async () => reminders.querySelector('summary')!.click());
    const details = [...host.querySelectorAll('details')].find(
      (e) =>
        e.querySelector('summary')?.textContent ===
        'Find this transaction in saved history',
    )!;
    expect(details).toBeTruthy();
    await act(async () => details.querySelector('summary')!.click());
    await click('Read saved outcome');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const signal = fetcher.mock.calls[0][1]!.signal!;
    await click('Pause');
    expect(host.textContent).toContain(
      'Paused. Existing transaction outcomes are retained',
    );
    expect(details.isConnected).toBe(true);
    expect(details.open).toBe(true);
    expect(signal.aborted).toBe(false);
    await act(async () => finish(Response.json(autoSellOutcomePage())));
    expect(details.textContent).toContain(
      'Submission recorded; receipt proof not loaded',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Accounted tokens5');
    for (let n = 0; n < 105; n++) {
      await click('Resume');
      await click('Pause');
    }
    expect(
      host.querySelector('[aria-label="Auto Sell activity"]')!.textContent,
    ).not.toContain('Synthetic unknown outcome');
    expect(details.isConnected).toBe(true);
    expect(details.open).toBe(true);
    expect(reminders.open).toBe(true);
    expect(details.textContent).toContain(
      'Submission recorded; receipt proof not loaded',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mocks.sell).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('Accounted tokens5');
  } finally {
    await act(async () => root.unmount());
    restoreLocks();
    host.remove();
    localStorage.removeItem('synthetic-outcome-modal-no-vault');
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetAllMocks();
  }
});
