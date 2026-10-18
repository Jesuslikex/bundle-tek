// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import bs58 from 'bs58';
vi.mock('./evm-holdings-panel', () => ({ EvmHoldingsPanel: () => null }));
vi.mock('./evm-tracked-wallet', () => ({ EvmTrackedWallet: () => null }));
vi.mock('./evm-tracked-transactions', () => ({
  EvmTrackedTransactions: () => null,
}));
vi.mock('./wallet-holdings-panel', () => ({ WalletHoldingsPanel: () => null }));
vi.mock('./tracked-transaction-panel', () => ({
  TrackedTransactionPanel: () => null,
}));
vi.mock('./tracked-transaction-history', () => ({
  TrackedTransactionHistory: () => null,
}));
import { WalletTracker } from './wallet-tracker';
import type { TrackedWallet } from '@/lib/tracked-wallet';
let root: Root,
  container: HTMLDivElement,
  rows: TrackedWallet[],
  writes: Array<{ action: string; wallets: unknown[] }>;
const address = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rows = [];
  writes = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (
        (typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url) !== '/api/tracker'
      )
        throw new Error('Unexpected provider request');
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        writes.push(body);
        rows.push(
          ...body.wallets.map((w: TrackedWallet) => ({
            ...w,
            archived: false,
            updatedAt: '2026-10-18T00:00:00.000Z',
          })),
        );
        return Response.json({ added: body.wallets.length });
      }
      return Response.json({ wallets: rows });
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (name: string) => {
  const b = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === name,
  );
  expect(b, name).toBeTruthy();
  return b!;
};
const click = async (name: string) => act(async () => button(name).click());
async function paste(text: string) {
  const input = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const mount = async () => {
  await act(async () => root.render(<WalletTracker onSupply={() => {}} />));
  await click('Bulk add');
};
it('previews comma addresses without writing, then saves only on explicit confirmation', async () => {
  await mount();
  await paste(`${address(1)},${address(2)}`);
  await click('Preview watchlist');
  expect(writes).toEqual([]);
  expect(
    container.querySelector('[aria-label="Public watchlist import preview"]')
      ?.textContent,
  ).toContain('2 new public addresses');
  await click('Save 2 public addresses');
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    action: 'add',
    wallets: [
      { address: address(1), network: 'mainnet' },
      { address: address(2), network: 'mainnet' },
    ],
  });
  expect(container.querySelector('textarea')).toBeNull();
  expect(container.textContent).toContain('2 public addresses saved.');
});
it('maps imported names/icons/bookmarks, skips archived entries and never restores them', async () => {
  rows = [
    {
      address: address(1),
      network: 'mainnet',
      label: 'Saved',
      group: '',
      icon: '⭐',
      favorite: false,
      archived: true,
      updatedAt: '2026-10-18T00:00:00.000Z',
    },
  ];
  await mount();
  await paste(
    JSON.stringify([
      { address: address(1), name: 'Do not overwrite' },
      {
        address: address(2),
        name: 'Research whale',
        icon: '🐋',
        bookmark: true,
      },
    ]),
  );
  await click('Preview watchlist');
  expect(container.textContent).toContain(
    '1 already saved entries will be skipped',
  );
  expect(container.textContent).toContain('including 1 archived');
  await click('Save 1 public address');
  expect(writes[0].wallets).toEqual([
    {
      address: address(2),
      network: 'mainnet',
      label: 'Research whale',
      group: '',
      icon: '🐋',
      favorite: true,
    },
  ]);
  expect(rows[0].label).toBe('Saved');
  expect(rows[0].archived).toBe(true);
});
it('invalidates the review when text or network changes before saving', async () => {
  await mount();
  await paste(address(1));
  await click('Preview watchlist');
  await paste(address(2));
  expect(
    container.querySelector('[aria-label="Public watchlist import preview"]'),
  ).toBeNull();
  expect(button('Preview watchlist')).toBeTruthy();
  expect(writes).toHaveLength(0);
  await click('Preview watchlist');
  const select = container.getElementsByTagName('select')[0];
  await act(async () => {
    select.value = 'devnet';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(
    container.querySelector('[aria-label="Public watchlist import preview"]'),
  ).toBeNull();
  expect(writes).toHaveLength(0);
  await click('Preview watchlist');
  await click('Save 1 public address');
  expect(writes[0].wallets[0]).toMatchObject({
    address: address(2),
    network: 'devnet',
  });
});
it('rejects unsupported secret-bearing objects locally with no write and no raw value in the error', async () => {
  await mount();
  await paste(
    JSON.stringify([{ address: address(1), secretKey: 'SYNTHETIC_NOT_A_KEY' }]),
  );
  await click('Preview watchlist');
  expect(container.querySelector('[role=alert]')?.textContent).toContain(
    'Row 1: unsupported fields',
  );
  expect(container.querySelector('[role=alert]')?.textContent).not.toContain(
    'SYNTHETIC_NOT_A_KEY',
  );
  expect(writes).toEqual([]);
  await paste(address(1));
  expect(container.querySelector('[role=alert]')).toBeNull();
  await click('Preview watchlist');
  expect(button('Save 1 public address')).toBeTruthy();
  expect(writes).toEqual([]);
});
it('disables saving an entirely existing batch and explains archived recovery', async () => {
  rows = [
    {
      address: address(1),
      network: 'mainnet',
      label: 'Saved',
      group: '',
      icon: '⭐',
      favorite: false,
      archived: true,
      updatedAt: '2026-10-18T00:00:00.000Z',
    },
  ];
  await mount();
  await paste(address(1));
  await click('Preview watchlist');
  expect(button('Save 0 public addresses').disabled).toBe(true);
  expect(container.textContent).toContain('restore it in the Archived view');
  expect(writes).toEqual([]);
});
