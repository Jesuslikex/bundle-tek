// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  group: vi.fn(),
  native: vi.fn(),
  withdraw: vi.fn(),
  execute: vi.fn(),
  unlock: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    useSession: () => ({ data: { user: { id: 'owner' } } }),
  }),
}));
vi.mock('./use-imported-projects', () => ({
  useImportedProjects: () => ({
    projects: [
      {
        id: 'p1',
        revision: 1,
        archived: false,
        document: {
          token: {
            chain: 'Solana',
            address: 'M1',
            decimals: 6,
            symbol: 'TEK',
            totalSupplyRaw: '1000000000000',
          },
        },
      },
    ],
    refresh: mocks.refresh,
  }),
}));
vi.mock('@/lib/auto-sell-feed', () => ({
  createAutoSellFeed: () => async () => [{ priceUsd: '0.01' }],
}));
vi.mock('@/lib/imported-trade-execute', () => ({
  readGroupTokenBalances: mocks.group,
  executeImportedTrade: mocks.execute,
}));
vi.mock('@/lib/browser-wallet-vault', () => ({
  VAULT_STORAGE_KEY: 'vault',
  unlockVault: mocks.unlock,
}));
vi.mock('@/lib/recover-funds', async (orig) => ({
  ...(await orig<typeof import('@/lib/recover-funds')>()),
  readNativeBalances: mocks.native,
  withdrawSolToFunder: mocks.withdraw,
}));
import { RecoverFunds } from './recover-funds';
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: { unmount(): void }[] = [];
afterEach(() => {
  act(() => roots.splice(0).forEach((r) => r.unmount()));
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});
it('scans launches into token rows plus one leftover SOL row and gates Reclaim all behind the acknowledgement', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
    (typeof url === 'string'
      ? url
      : url instanceof URL
        ? url.href
        : url.url
    ).includes('market-prices')
      ? new Response(JSON.stringify({ prices: [{ symbol: 'SOL', usd: 150 }] }))
      : new Response(
          JSON.stringify({
            wallets: [
              {
                chain: 'Solana',
                address: 'F1',
                role: 'Funder',
                archived: false,
                revision: 1,
                label: 'fund',
              },
              {
                chain: 'Solana',
                address: 'H1',
                role: 'Recipient',
                archived: false,
                revision: 1,
                label: 'h1',
              },
            ],
          }),
        ),
  );
  mocks.native.mockResolvedValue({ H1: 2_000_000_000n });
  mocks.group.mockResolvedValue({ H1: 5_000_000_000n });
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  await act(async () => root.render(<RecoverFunds />));
  expect(el.querySelector('select')!.value).toBe('F1');
  const scan = [...el.querySelectorAll('button')].find(
    (b) => b.textContent === 'Scan launches',
  )!;
  await act(async () => scan.click());
  expect(mocks.native).toHaveBeenCalledWith(['H1'], expect.anything());
  expect(mocks.group.mock.calls[0][1]).toEqual([
    expect.objectContaining({ address: 'H1' }),
  ]);
  expect(el.textContent).toContain('TEK');
  expect(el.textContent).toContain('$50.00');
  expect(el.textContent).toContain('Leftover SOL');
  const all = [...el.querySelectorAll('button')].find(
    (b) => b.textContent === 'Reclaim all',
  )!;
  expect(all.disabled).toBe(true);
});
