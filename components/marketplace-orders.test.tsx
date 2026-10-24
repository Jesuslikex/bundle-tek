// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarketplaceDeliveries, MarketplaceOrders } from './marketplace-orders';

let container: HTMLDivElement, root: Root;
const fetcher = vi.fn();
const order = (state: string) => ({
  document: {
    id: '00000000-0000-4000-8000-000000000009',
    amountLamports: '100000000',
    addresses: ['A'.repeat(44), 'B'.repeat(44)],
    buyerWallet: 'C'.repeat(44),
  },
  state,
  signature: '5'.repeat(88),
  receipt: null,
  updatedAt: '2026-10-24T00:00:00.000Z',
  deliveries: [],
});
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  fetcher.mockReset();
});
const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {});
};
const button = (text: string) =>
  [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith(text),
  )!;

it('lists orders and checks a sent payment without resending it', async () => {
  fetcher.mockImplementation(async (_url: string, init?: RequestInit) =>
    Response.json(
      init?.method === 'POST'
        ? { order: order('paid') }
        : { orders: [order('submitted')] },
    ),
  );
  act(() => root.render(<MarketplaceOrders />));
  await flush();
  expect(container.textContent).toContain('2 wallets for 0.1 SOL · submitted');
  await act(async () => button('Check payment').click());
  await flush();
  const posts = fetcher.mock.calls.filter(([, i]) => i?.method === 'POST');
  expect(posts.map(([, i]) => JSON.parse(i.body as string))).toEqual([
    { action: 'recover', id: order('x').document.id },
  ]);
});

it('shows seller deliveries and needs the vault passphrase to deliver', async () => {
  fetcher.mockResolvedValue(
    Response.json({
      pending: [
        {
          orderId: order('x').document.id,
          deliveryPublicKey: 'k'.repeat(44),
          paidAt: '2026-10-24T00:00:00.000Z',
          addresses: ['A'.repeat(44)],
        },
      ],
    }),
  );
  act(() => root.render(<MarketplaceDeliveries />));
  await flush();
  expect(container.textContent).toContain('1 wallet');
  expect(button('Deliver encrypted keys').disabled).toBe(true);
});
