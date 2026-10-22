// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AutoSell } from './auto-sell-modal';
import { installAutoSellBrowserLocks } from '../test/auto-sell-browser-lock-fixture';
import { AutoSellReviewRecoveryError } from '@/lib/auto-sell-review-recovery';
import {
  autoSellReviewReference,
  autoSellUnsignedReviewPage,
} from '../test/auto-sell-review-fixture';
import { autoSellOutcomeReference as ref } from '../test/auto-sell-outcome-fixture';
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
  VAULT_STORAGE_KEY: 'synthetic-review-recovery-modal-no-vault',
  unlockVault: mocks.unlock,
}));
vi.mock('@/lib/auto-sell-feed', () => ({
  createAutoSellFeed: () => mocks.read,
}));
vi.mock('@/lib/auto-sell-execute', () => ({
  createAutoSellExecutor: () => mocks.sell,
}));
it('mounts original-review recovery in the actual stopped modal and does not resume after manual cancellation', async () => {
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
    new AutoSellReviewRecoveryError(autoSellReviewReference),
  );
  let finish!: (r: Response) => void;
  const fetcher = vi.fn(
    (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  localStorage.setItem('synthetic-review-recovery-modal-no-vault', 'SYNTHETIC');
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
    const recovery = host.querySelector<HTMLElement>(
      '[aria-label="Interrupted Auto Sell review"]',
    )!;
    expect(recovery).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Accounted tokens0');
    await click('Read original saved review');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]?.method).toBe('GET');
    await act(async () => finish(Response.json(autoSellUnsignedReviewPage())));
    await click('Cancel unsigned approval');
    expect(fetcher).toHaveBeenCalledOnce();
    await act(async () =>
      recovery
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .click(),
    );
    await click('Cancel unsigned approval');
    expect(fetcher).toHaveBeenCalledTimes(2);
    await fill('input[type="password"]', 'synthetic');
    const runButton = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Run 1 Strategy',
    )!;
    expect(runButton.disabled).toBe(true);
    await click('Run 1 Strategy');
    expect(mocks.unlock).toHaveBeenCalledOnce();
    expect(host.textContent).toContain(
      'Check the original saved approval status',
    );
    expect(fetcher.mock.calls[1][1]?.method).toBe('POST');
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)).toEqual({
      action: 'cancel',
      id: ref.intentId,
    });
    await act(async () => finish(Response.json({ state: 'cancelled' })));
    expect(recovery.textContent).toContain('Cancellation acknowledged');
    expect(runButton.disabled).toBe(true);
    await click('Check saved status');
    const cancelled = autoSellUnsignedReviewPage();
    cancelled.intents[0].state = 'cancelled';
    await act(async () => finish(Response.json(cancelled)));
    expect(recovery.textContent).toContain('Saved approval is cancelled');
    expect(host.textContent).toContain('Accounted tokens0');
    await act(async () => vi.advanceTimersByTimeAsync(20000));
    expect(mocks.sell).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(mocks.unlock).toHaveBeenCalledOnce();
    const secondReference = {
      ...autoSellReviewReference,
      preparationId: '44444444-4444-4444-8444-444444444444',
    };
    mocks.sell.mockRejectedValue(
      new AutoSellReviewRecoveryError(secondReference, true),
    );
    mocks.unlock.mockImplementation(async () => ({
      payload: { wallets: [{ family: 'solana', address: ref.wallet }] },
    }));
    mocks.feed = [];
    await fill('input[type="password"]', 'synthetic');
    await click('Run 1 Strategy');
    expect(recovery.isConnected).toBe(true);
    mocks.feed = [
      {
        id: 'second-synthetic-buy',
        sender: 'OUTSIDE',
        side: 'Buy',
        tokenAmount: '10',
        quoteAmount: '1',
        priceUsd: '1',
        timestamp: new Date().toISOString(),
      },
    ];
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(mocks.sell).toHaveBeenCalledTimes(2);
    expect(
      host.querySelectorAll('[aria-label="Interrupted Auto Sell review"]'),
    ).toHaveLength(2);
    expect(recovery.isConnected).toBe(true);
    expect(recovery.textContent).toContain(
      autoSellReviewReference.preparationId,
    );
    expect(host.textContent).toContain(secondReference.preparationId);
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
    restoreLocks();
    host.remove();
    localStorage.removeItem('synthetic-review-recovery-modal-no-vault');
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetAllMocks();
  }
});
