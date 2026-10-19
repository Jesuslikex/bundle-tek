// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarketplacePanel } from './marketplace-panel';
import { marketplaceFixture } from '../test/marketplace-fixture';
import {
  marketplaceFilters,
  selectMarketplaceInventory,
} from '../lib/marketplace-catalog';
let root: Root, container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<MarketplacePanel />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('marks a previously displayed snapshot expired using its own server expiry', async () => {
  vi.useFakeTimers();
  const data = selectMarketplaceInventory(
    marketplaceFixture(),
    marketplaceFilters.parse({}),
    Date.now(),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(data)),
  );
  await submit();
  await act(async () => vi.advanceTimersByTime(60000));
  expect(container.textContent).toContain('Expired. Refresh inventory.');
});

it('rejects responses that claim purchase authority or contain unexpected fields', async () => {
  const data = selectMarketplaceInventory(
    marketplaceFixture(),
    marketplaceFilters.parse({}),
    Date.now(),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ...data, purchaseEnabled: true })),
  );
  await submit();
  expect(container.querySelector('table')).toBeNull();
  expect(container.querySelector('[role=alert]')?.textContent).toBe(
    'Inventory response was invalid.',
  );
});
async function submit() {
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}
it('starts with explicit unavailable checkout and no invented catalog or purchase button', () => {
  expect(container.textContent).toContain('Checkout unavailable');
  expect(container.querySelector('table')).toBeNull();
  expect(container.querySelector('details')?.open).toBe(false);
  expect(container.textContent).toContain('Reset filters');
});
async function field(name: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(
    `input[name="${name}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function catalogTransport(inventory?: ReturnType<typeof marketplaceFixture>) {
  const fetcher = vi.fn(async (url: string) =>
    Response.json(
      selectMarketplaceInventory(
        inventory ?? marketplaceFixture(),
        marketplaceFilters.parse(
          Object.fromEntries(new URL(url, 'https://bundle.test').searchParams),
        ),
        Date.now(),
      ),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
async function toggle(text: string) {
  const label = [...container.querySelectorAll('label')].find(
    (item) => item.textContent?.trim() === text,
  )!;
  await act(async () =>
    label.querySelector<HTMLInputElement>('input')!.click(),
  );
}
it('shows missing regions honestly and supports exact single/multiple reported-region selection', async () => {
  const inventory = marketplaceFixture();
  inventory.listings[0].region = 'Europe';
  inventory.listings[1].region = 'Asia';
  const fetcher = catalogTransport(inventory);
  await submit();
  expect(container.textContent).toContain('Not reported');
  expect(container.textContent).toContain('wallet location is not verified');
  await toggle('Europe');
  await toggle('Asia');
  await submit();
  const query = new URL(fetcher.mock.calls.at(-1)![0], 'https://bundle.test')
    .searchParams;
  expect(JSON.parse(query.get('regions')!).sort()).toEqual(['Asia', 'Europe']);
  expect(query.has('region')).toBe(false);
  expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
  expect(
    [...container.querySelectorAll('tbody tr')].map(
      (row) => row.querySelectorAll('td')[5].textContent,
    ),
  ).toEqual(['Europe', 'Asia']);
  await field('region', 'Europe');
  await submit();
  const single = new URL(fetcher.mock.calls.at(-1)![0], 'https://bundle.test')
    .searchParams;
  expect(single.get('region')).toBe('Europe');
  expect(single.has('regions')).toBe(false);
  expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  expect(container.textContent).toContain('Checkout unavailable');
  expect(
    fetcher.mock.calls.every((call) =>
      String(call[0]).startsWith('/api/marketplace/catalog?'),
    ),
  ).toBe(true);
});
it('resets region selection without fetching or fabricating a missing label', async () => {
  const fetcher = catalogTransport();
  await field('region', 'Europe');
  await submit();
  expect(container.querySelectorAll('tbody tr')).toHaveLength(0);
  expect(container.textContent).not.toContain('Europe (not in latest catalog)');
  const calls = fetcher.mock.calls.length;
  await act(async () => container.querySelector('form')!.reset());
  expect(
    container.querySelector<HTMLInputElement>('input[name=region]')!.value,
  ).toBe('');
  expect(container.querySelector('input[name=regions]')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(calls);
  await submit();
  expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
  expect(container.textContent).toContain('Not reported');
});
it('refuses region metadata that disagrees with a listing rather than exposing parser errors', async () => {
  const inventory = marketplaceFixture();
  inventory.listings[0].region = 'Europe';
  const result = selectMarketplaceInventory(
    inventory,
    marketplaceFilters.parse({}),
    Date.now(),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ...result, regions: ['Asia'] })),
  );
  await submit();
  expect(container.querySelector('table')).toBeNull();
  expect(container.querySelector('[role=alert]')?.textContent).toBe(
    'Inventory response was invalid.',
  );
});
it('explains a malformed region without sending a catalog request', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await field('region', ' Europe');
  await submit();
  expect(fetcher).not.toHaveBeenCalled();
  const input =
    container.querySelector<HTMLInputElement>('input[name=region]')!;
  expect(input.getAttribute('aria-label')).toBe('Reported region');
  expect(
    document.getElementById(input.getAttribute('aria-describedby')!)
      ?.textContent,
  ).toContain('spelling and capitalization');
  expect(container.querySelector('[role=alert]')?.textContent).toBe(
    'Enter a region exactly as reported, or choose from the reported regions.',
  );
});
it('keeps reported source choices available while combining filters and supports a custom quantity', async () => {
  const fetcher = catalogTransport();
  await submit();
  await field('count', '7');
  await toggle('Classic');
  await toggle('Exchange');
  await toggle('Funding only');
  await toggle('Light history');
  await submit();
  const query = new URL(fetcher.mock.calls.at(-1)![0], 'https://bundle.test')
    .searchParams;
  expect(query.get('count')).toBe('7');
  expect(JSON.parse(query.get('sources')!)).toEqual(['Classic', 'Exchange']);
  expect(JSON.parse(query.get('tiers')!)).toEqual([
    'funding-only',
    'light-history',
  ]);
  expect(query.has('source')).toBe(false);
  expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
  await field('source', 'Classic');
  await submit();
  const single = new URL(fetcher.mock.calls.at(-1)![0], 'https://bundle.test')
    .searchParams;
  expect(single.get('source')).toBe('Classic');
  expect(single.has('sources')).toBe(false);
});
it('sorts captured rows and phone cards without fetching again or changing exact totals', async () => {
  const fetcher = catalogTransport();
  await submit();
  const total = container.querySelector('output')?.textContent;
  const sortButton = [...container.querySelectorAll('th button')].find(
    (button) => button.textContent?.startsWith('Price ↑'),
  )!;
  await act(async () => (sortButton as HTMLButtonElement).click());
  expect(container.querySelector('tbody tr code')?.textContent).toBe(
    marketplaceFixture().listings[2].address,
  );
  expect(
    container.querySelector('th[aria-sort="descending"]')?.textContent,
  ).toContain('Price');
  expect(
    container.querySelector('[aria-label="Wallet inventory cards"] li code')
      ?.textContent,
  ).toBe(marketplaceFixture().listings[2].address);
  expect(container.querySelector('output')?.textContent).toBe(total);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(container.querySelector('tbody tr')?.textContent).toContain(
    '0.100000002 SOL',
  );
});
it('presets invalidate stale rows, reset clears multiple choices, and invalid custom counts never fetch', async () => {
  const fetcher = catalogTransport();
  await submit();
  const preset = container.querySelector<HTMLButtonElement>(
    '[aria-label="Choose 100 wallets"]',
  )!;
  await act(async () => preset.click());
  expect(
    (container.querySelector('input[name=count]') as HTMLInputElement).value,
  ).toBe('100');
  expect(container.querySelector('table')).toBeNull();
  await toggle('Classic');
  await toggle('Established');
  await act(async () =>
    container.querySelector<HTMLFormElement>('form')!.reset(),
  );
  expect(
    (container.querySelector('input[name=count]') as HTMLInputElement).value,
  ).toBe('25');
  expect(container.querySelector('input[type=hidden]')).toBeNull();
  await field('count', '201');
  await submit();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('sends exact SOL ranges as lamports and blocks inverted ranges before fetching', async () => {
  const fetcher = vi.fn(async (_url: string) =>
    Response.json({}, { status: 503 }),
  );
  vi.stubGlobal('fetch', fetcher);
  await field('minimumBalanceSol', '0.000000001');
  await field('maximumBalanceSol', '9007199.254740993');
  await field('minimumTransactions', '2');
  await field('maximumTransactions', '12');
  await submit();
  const url = new URL(fetcher.mock.calls[0][0], 'https://bundle.example');
  expect(url.searchParams.get('minimumBalanceLamports')).toBe('1');
  expect(url.searchParams.get('maximumBalanceLamports')).toBe(
    '9007199254740993',
  );
  expect(url.searchParams.get('minimumTransactions')).toBe('2');
  await field('maximumTransactions', '1');
  await submit();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role=alert]')?.textContent).toContain(
    'Maximum values',
  );
});
it('rejects a response for different filters and reset clears rows without refetching', async () => {
  const data = selectMarketplaceInventory(
    marketplaceFixture(),
    marketplaceFilters.parse({ count: 50 }),
    Date.now(),
  );
  const fetcher = vi.fn(async () => Response.json(data));
  vi.stubGlobal('fetch', fetcher);
  await submit();
  expect(container.querySelector('table')).toBeNull();
  expect(container.textContent).toContain('Inventory filters differ');
  data.filters.count = 25;
  await submit();
  expect(container.querySelector('table')).not.toBeNull();
  await act(async () =>
    container.querySelector<HTMLFormElement>('form')!.reset(),
  );
  expect(container.querySelector('table')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('handles an HTML error without showing parser text and offers sign-in on 401', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('<html>private</html>', { status: 502 })),
  );
  await submit();
  expect(container.querySelector('[role=alert]')?.textContent).toBe(
    'Inventory could not be loaded. Try again later.',
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({}, { status: 401 })),
  );
  await submit();
  expect(container.querySelector('a')?.getAttribute('href')).toBe('/sign-in');
});
it('separates unavailable sign-in from unavailable inventory', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ code: 'AUTH_UNAVAILABLE' }, { status: 503 }),
    ),
  );
  await submit();
  expect(container.querySelector('[role=alert]')?.textContent).toBe(
    'Bundle sign-in is temporarily unavailable. Try again later.',
  );
});
it('renders provider coverage and exact totals, then clears stale rows when filters change', async () => {
  const data = selectMarketplaceInventory(
    marketplaceFixture(),
    marketplaceFilters.parse({}),
    Date.now(),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(data)),
  );
  await submit();
  expect(container.textContent).toContain('Partial provider coverage');
  expect(container.textContent).toContain('3.300000003 SOL');
  await field('count', '50');
  expect(container.querySelector('table')).toBeNull();
});
it('does not publish an old request after filters change', async () => {
  let resolve!: (r: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    ),
  );
  await submit();
  await field('count', '50');
  await act(async () => {
    resolve(
      Response.json(
        selectMarketplaceInventory(
          marketplaceFixture(),
          marketplaceFilters.parse({}),
          Date.now(),
        ),
      ),
    );
  });
  expect(container.querySelector('table')).toBeNull();
});
