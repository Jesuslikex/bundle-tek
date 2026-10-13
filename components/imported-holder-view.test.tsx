// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import bs58 from 'bs58';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ImportedHolderView } from './imported-holder-view';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import { MAX_WATCHED_WALLETS } from '@/lib/supply-watch-wallet';

const address = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const mint = address(200);
const project = {
  id: '11111111-1111-4111-8111-111111111111',
  archived: false,
  document: {
    token: { chain: 'Solana', address: mint, decimals: 6, symbol: 'TEST' },
  },
} as unknown as ImportedTokenProject;
const holders = [address(1), address(2)];
const summary = {
  mint,
  network: 'mainnet',
  decimals: 6,
  slot: 10,
  observedAt: '2026-10-13T00:00:00.000Z',
  totalSupplyRaw: '1000',
  bundle: { raw: '0', walletCount: 0 },
  external: { raw: '1000' },
  topExternal: holders.map((owner, i) => ({
    owner,
    raw: String(300 - i * 100),
    rank: i + 1,
  })),
};

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(
  response: Response,
  watched: string[],
  pending: string[] = [],
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  );
  await act(async () => {
    root.render(
      <ImportedHolderView
        project={project}
        excludedWallets={[]}
        autoLoad
        watchedWallets={watched}
        pendingWatchWallets={pending}
        onWatch={() => {}}
      />,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}
const watchButtons = () =>
  Array.from(container.querySelectorAll('button')).filter((b) =>
    b.getAttribute('aria-label')?.startsWith('Watch holder'),
  );

it('explains a full watchlist and counts in-flight saves toward the cap', async () => {
  const others = Array.from({ length: MAX_WATCHED_WALLETS - 1 }, (_, i) =>
    address(50 + i),
  );
  await mount(Response.json(summary), others, [holders[0]]);
  expect(watchButtons().map((b) => [b.textContent, b.disabled])).toEqual([
    ['Saving…', true],
    ['Watch wallet', true],
  ]);
  expect(container.textContent).toContain(
    `Your watchlist is full (${MAX_WATCHED_WALLETS} wallets)`,
  );
});

it('keeps Watch available below the cap without the full-list notice', async () => {
  await mount(Response.json(summary), [holders[0]]);
  expect(watchButtons().map((b) => [b.textContent, b.disabled])).toEqual([
    ['Watching', true],
    ['Watch wallet', false],
  ]);
  expect(container.textContent).not.toContain('watchlist is full');
});

it('shows a plain message when the server returns a non-JSON error page', async () => {
  await mount(
    new Response('<html>Bad gateway</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    }),
    [],
  );
  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toBe('Sampled holder read unavailable.');
});
