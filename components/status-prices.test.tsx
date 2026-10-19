// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StatusPrices } from './status-prices';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const byTitle = (title: string) =>
  Array.from(container.querySelectorAll('[title]')).find(
    (node) => node.getAttribute('title') === title,
  );

it('shows reference prices from the API', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        prices: [
          { symbol: 'SOL', usd: 182.4, change24h: 2.5 },
          { symbol: 'ETH', usd: 2451, change24h: -1 },
        ],
      }),
    ),
  );
  await act(async () => root.render(<StatusPrices />));
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  const sol = byTitle('SOL +2.50% in 24h');
  const eth = byTitle('ETH -1.00% in 24h');
  expect(sol?.textContent).toContain('$182');
  expect(eth?.textContent).toContain('$2,451');
});

it('renders nothing when prices are unavailable', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 503 })),
  );
  await act(async () => root.render(<StatusPrices />));
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(container.textContent).toBe('');
});
