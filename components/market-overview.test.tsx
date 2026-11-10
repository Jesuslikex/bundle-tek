// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarketOverview } from './market-overview';

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
const v = (day: number) => ({
  '24h': day,
  '7d': day * 5,
  '30d': day * 30,
  all: null,
});
const overview = {
  observedAt: '2026-11-10T00:00:00.000Z',
  source: 'DefiLlama',
  networks: [
    {
      id: 'All',
      volume: v(9_000_000),
      change1d: 3.2,
      launchpads: [
        {
          name: 'pump.fun',
          chains: ['Solana'],
          volume: v(2_000_000),
          change1d: 5,
        },
        {
          name: 'Four.meme',
          chains: ['BSC'],
          volume: v(500_000),
          change1d: -1,
        },
      ],
      trench: { score: 62, label: 'Hot' },
    },
    {
      id: 'Solana',
      volume: v(4_000_000),
      change1d: 1,
      launchpads: [
        {
          name: 'pump.fun',
          chains: ['Solana'],
          volume: v(2_000_000),
          change1d: 5,
        },
      ],
      trench: { score: 40, label: 'Neutral' },
    },
    {
      id: 'Base',
      volume: v(5_000_000),
      change1d: null,
      launchpads: [],
      trench: null,
    },
  ],
};
const button = (text: string) =>
  Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.trim().startsWith(text),
  )!;
const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

it('does not fetch until opened, then shows totals, rankings and the trench index', async () => {
  const fetchMock = vi.fn(async () => Response.json(overview));
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => root.render(<MarketOverview />));
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => button('Market').click());
  await tick();
  expect(fetchMock).toHaveBeenCalledOnce();
  const panel = container.querySelector('[aria-label="Market Overview"]')!;
  expect(panel.textContent).toContain('$9M');
  expect(panel.textContent).toContain('+3.2%');
  expect(panel.textContent).toContain('62/100');
  expect(panel.textContent).toContain('Hot');
  const chains = [...panel.querySelectorAll('ol')][0];
  expect(
    [...chains.querySelectorAll('li')].map((li) => li.textContent),
  ).toEqual(['Base$5M', 'Solana$4M']);
  expect(panel.textContent).toContain('Four.meme');
});

it('switches period and network', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(overview)),
  );
  await act(async () => root.render(<MarketOverview />));
  await act(async () => button('Market').click());
  await tick();
  await act(async () => button('30d').click());
  const panel = container.querySelector('[aria-label="Market Overview"]')!;
  expect(panel.textContent).toContain('$270M');
  await act(async () => button('Solana').click());
  expect(panel.textContent).toContain('$120M');
  expect(panel.textContent).toContain('40/100');
  expect(panel.textContent).not.toContain('Four.meme');
  await act(async () => button('Base').click());
  expect(panel.textContent).toContain('No launchpad volume reported.');
});

it('says so when the overview is unavailable and closes on Escape', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'x' }, { status: 503 })),
  );
  await act(async () => root.render(<MarketOverview />));
  await act(async () => button('Market').click());
  await tick();
  expect(container.querySelector('[role="alert"]')!.textContent).toContain(
    'unavailable',
  );
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
  );
  expect(container.querySelector('[aria-label="Market Overview"]')).toBeNull();
});
