// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarketCleanupPanel } from './market-cleanup-panel';
import type { ImportedTokenProject } from '@/lib/imported-token-project';
import type { WorkspaceWallet } from '@/lib/wallet-workspace';

const project = {
  id: '00000000-0000-4000-8000-000000000001',
  revision: 2,
  archived: false,
  updatedAt: '2026-10-24T00:00:00.000Z',
  document: {
    token: {
      chain: 'Solana',
      address: 'Mint111111111111111111111111111111111111111',
      symbol: 'CAT',
      name: 'Cat',
      decimals: 6,
      totalSupplyRaw: '1000',
    },
  },
} as unknown as ImportedTokenProject;
const wallet = (n: number) =>
  ({
    address: `Wa11et${n}`.padEnd(44, '1'),
    chain: 'Solana',
    revision: 1,
    archived: false,
    label: `Wallet ${n}`,
  }) as unknown as WorkspaceWallet;
const wallets = [wallet(1), wallet(2), wallet(3)];

let container: HTMLDivElement, root: Root;
const fetcher = vi.fn();
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetcher
    .mockReset()
    .mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { wallets: string[] };
      return Response.json({
        balances: body.wallets.map((w, i) => ({
          wallet: w,
          tokenRaw: i === 0 ? '250' : '0',
          lamports: '2000000000',
        })),
      });
    });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (text: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )!;
const box = (legend: string, label: string) => {
  const set = [...container.querySelectorAll('fieldset')].find((f) =>
    f.querySelector('legend')?.textContent?.startsWith(legend),
  )!;
  return [...set.querySelectorAll('label')]
    .find((l) => l.textContent?.includes(label))!
    .querySelector('input') as HTMLInputElement;
};

it('keeps sellers and buyers apart, shows group supply and never trades on its own', async () => {
  act(() =>
    root.render(
      <MarketCleanupPanel project={project} wallets={wallets} locked={false} />,
    ),
  );
  expect(container.textContent).toContain('Cleanup: sell→buy rounds');
  act(() => box('Input wallets', 'Wallet 1').click());
  act(() => box('Output wallets', 'Wallet 1').click());
  // Choosing a wallet as a buyer removes it from the sellers.
  expect(box('Input wallets', 'Wallet 1').checked).toBe(false);
  act(() => box('Input wallets', 'Wallet 2').click());
  await act(async () => button('Read balances').click());
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({
    projectId: project.id,
    revision: 2,
    wallets: [wallets[1].address, wallets[0].address],
  });
  expect(container.textContent).toContain('Total 25.00% of supply');
  expect(button('Start Cleanup').disabled).toBe(true);
  expect(
    fetcher.mock.calls.some(([url]) => url !== '/api/market-cleanup/balances'),
  ).toBe(false);
});
