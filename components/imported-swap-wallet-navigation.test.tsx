// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ImportedSwapWallet } from './imported-swap-wallet';
import { ImportedWorkspaceViews } from './imported-workspace-frame';
import { requestImportedWalletReview } from '@/lib/imported-wallet-review-events';
import { importedTokenDocument } from '@/lib/imported-token-project';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';
import {
  acquisitionId,
  acquisitionMint,
  acquisitionWallet,
} from '@/test/imported-sell-acquisition-fixture';

// Exercise the actual wallet selection, inventory and scoped handoff listener.
// Financial children are placeholders; this is not signing/preparation proof.
vi.mock('./imported-swap-preparation', () => ({
  ImportedSwapPreparation: ({ wallet }: { wallet: WorkspaceWallet }) => (
    <p data-testid="selected-preparation-wallet">{wallet.address}</p>
  ),
}));
vi.mock('./imported-sell-acquisitions', () => ({
  ImportedSellAcquisitions: () => <p>Retained acquisition review</p>,
}));
vi.mock('./imported-pair-trade-wallet-review', () => ({
  ImportedPairTradeWalletReview: () => <p>Pair review placeholder</p>,
}));
vi.mock('./imported-trade-sessions', () => ({
  ImportedTradeSessions: () => <p>Session review placeholder</p>,
}));

const stamp = '2026-10-18T00:00:00Z';
const project: ImportedTokenProject = {
  id: acquisitionId(1),
  revision: 1,
  archived: false,
  updatedAt: stamp,
  document: importedTokenDocument(
    { chain: 'Solana', address: acquisitionMint },
    {
      chain: 'Solana',
      address: acquisitionMint,
      name: 'Synthetic navigation token',
      symbol: 'QA',
      decimals: 6,
      totalSupplyRaw: '1000000000',
      metadataUri: '',
      source: 'https://fixture.test',
      observedAt: stamp,
    },
  ),
};
const wallet: WorkspaceWallet = {
  chain: 'Solana',
  address: acquisitionWallet,
  folderId: '',
  folderIds: [],
  label: 'Synthetic public wallet',
  role: 'Recipient',
  archived: false,
  revision: 1,
  updatedAt: stamp,
};
const reviewTrade = vi.fn();
const save = vi.fn();
let container: HTMLDivElement;
let root: Root;
let frames: FrameRequestCallback[];
let originalScroll: PropertyDescriptor | undefined;

function HolderAction({ address }: { address: string }) {
  const [notice, setNotice] = useState('');
  return (
    <>
      <button
        onClick={() => {
          setNotice(
            requestImportedWalletReview({
              projectId: project.id,
              revision: project.revision,
              mint: acquisitionMint,
              wallet: address,
              side: 'Buy',
            }) ?? 'Wallet selected for review.',
          );
        }}
      >
        Review watched wallet
      </button>
      <output data-testid="holder-review-result">{notice}</output>
    </>
  );
}
async function render(locked = false, requestedWallet = acquisitionWallet) {
  await act(async () => {
    root.render(
      <ImportedWorkspaceViews
        tabbed
        views={[
          {
            id: 'wallets',
            title: 'My wallets',
            content: (
              <ImportedSwapWallet
                project={project}
                side="Buy"
                amount="0.01"
                locked={locked}
                onSaved={save}
                onSavingChange={save}
                onAmountChange={save}
                onWalletTradeReview={reviewTrade}
              />
            ),
          },
          {
            id: 'holders',
            title: 'Holders',
            content: <HolderAction address={requestedWallet} />,
          },
        ]}
      />,
    );
  });
}
function button(text: string) {
  return [...container.querySelectorAll('button')].find(
    (element) =>
      element.getAttribute('aria-label') === text ||
      element.textContent === text,
  )!;
}
async function click(element: HTMLElement) {
  expect(element).toBeDefined();
  await act(async () => element.click());
  await act(async () => {
    const pending = frames;
    frames = [];
    pending.forEach((callback) => callback(performance.now()));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  originalScroll = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollIntoView',
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (
        input !== '/api/wallet-workspace' ||
        (init?.method ?? 'GET') !== 'GET'
      )
        throw new Error(
          'Unexpected provider or write request in navigation test',
        );
      return Response.json({ wallets: [wallet], folders: [], balances: [] });
    }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (originalScroll)
    Object.defineProperty(
      HTMLElement.prototype,
      'scrollIntoView',
      originalScroll,
    );
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  vi.unstubAllGlobals();
});

it('places the inventory first and reveals the selected-wallet review on a row action', async () => {
  await render();
  const inventory = container.querySelector(
    '.imported-project-wallet-inventory',
  )!;
  const review = container.querySelector<HTMLDetailsElement>(
    '.imported-selected-wallet-review',
  )!;
  expect(
    inventory.compareDocumentPosition(review) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(review.open).toBe(false);
  await click(
    container.querySelector<HTMLButtonElement>(
      `[aria-label="Review buy with ${acquisitionWallet}"]`,
    )!,
  );
  expect(review.open).toBe(true);
  expect(document.activeElement).toBe(review.querySelector('summary'));
  expect(
    container.querySelector('[data-testid="selected-preparation-wallet"]')
      ?.textContent,
  ).toBe(acquisitionWallet);
  expect(reviewTrade).toHaveBeenCalledExactlyOnceWith('Buy', undefined);
  expect(save).not.toHaveBeenCalled();
});

it('returns from holders to the retained wallet review after a valid scoped request', async () => {
  await render();
  await click(button('Holders'));
  await click(button('Review watched wallet'));
  expect(button('My wallets').getAttribute('aria-selected')).toBe('true');
  expect(
    container.querySelector<HTMLDetailsElement>(
      '.imported-selected-wallet-review',
    )!.open,
  ).toBe(true);
  expect(reviewTrade).toHaveBeenCalledExactlyOnceWith('Buy');
  expect(save).not.toHaveBeenCalled();
});

it('keeps the current view and selection unchanged when a wallet operation is locked', async () => {
  await render(true);
  await click(button('Holders'));
  await click(button('Review watched wallet'));
  expect(button('Holders').getAttribute('aria-selected')).toBe('true');
  expect(
    container.querySelector('[data-testid="holder-review-result"]')
      ?.textContent,
  ).toContain('Wait for the current wallet operation');
  expect(
    container.querySelector<HTMLDetailsElement>(
      '.imported-selected-wallet-review',
    )!.open,
  ).toBe(false);
  expect(reviewTrade).not.toHaveBeenCalled();
});

it('refuses an unavailable wallet without changing tabs or opening a review', async () => {
  await render(false, '11111111111111111111111111111111');
  await click(button('Holders'));
  await click(button('Review watched wallet'));
  expect(button('Holders').getAttribute('aria-selected')).toBe('true');
  expect(
    container.querySelector('[data-testid="holder-review-result"]')
      ?.textContent,
  ).toContain('active Solana wallet workspace');
  expect(
    container.querySelector<HTMLDetailsElement>(
      '.imported-selected-wallet-review',
    )!.open,
  ).toBe(false);
  expect(reviewTrade).not.toHaveBeenCalled();
});

it('offers visible roster recovery after an HTML error without exposing parser text', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response('<html>Temporary upstream error</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    }),
  );
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'Wallet list unavailable. Reload trade wallets to try again.',
  );
  expect(container.textContent).not.toContain('Unexpected token');
  const reload = button('Reload trade wallets');
  expect(reload.closest('[hidden], details:not([open])')).toBeNull();
  await click(reload);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain('Synthetic public wallet');
  expect(save).not.toHaveBeenCalled();
  expect(reviewTrade).not.toHaveBeenCalled();
});
