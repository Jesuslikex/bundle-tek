// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { MarketplaceOwnedWallets } from './marketplace-owned-wallets';
import { MarketplaceWorkspace } from './marketplace-workspace';
import { marketplaceOwnedFixture } from '../test/marketplace-owned-fixture';
import {
  buildMarketplaceOwnedInventory,
  MarketplaceInventoryCapacityError,
  marketplaceInventoryCapacityBody,
  MARKETPLACE_INVENTORY_CAPACITY_MESSAGE,
} from '@/lib/marketplace-owned-inventory';
import bs58 from 'bs58';
let root: Root, host: HTMLDivElement;
const now = Date.parse('2026-10-20T12:00:00Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount(workspace = false) {
  await act(async () =>
    root.render(
      workspace ? <MarketplaceWorkspace /> : <MarketplaceOwnedWallets />,
    ),
  );
}
async function click(text: string) {
  const target = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  );
  expect(target).toBeTruthy();
  await act(async () => target!.click());
}
function result() {
  return buildMarketplaceOwnedInventory(
    marketplaceOwnedFixture(now).sources,
    now,
  );
}

it.each(['saved-history-run-limit', 'saved-history-byte-limit'] as const)(
  'explains %s without retaining old rows, repeating reads or changing wallets',
  async (code) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(result()))
      .mockResolvedValueOnce(
        Response.json(
          marketplaceInventoryCapacityBody(
            new MarketplaceInventoryCapacityError(code),
          ),
          { status: 409 },
        ),
      );
    vi.stubGlobal('fetch', fetcher);
    await mount();
    await click('Load my inventory');
    expect(host.querySelectorAll('li').length).toBeGreaterThan(0);
    await click('Refresh my inventory');
    expect(host.querySelectorAll('li')).toHaveLength(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      MARKETPLACE_INVENTORY_CAPACITY_MESSAGE,
    );
    expect(host.textContent).toContain('Retrying alone will not fix');
    expect(host.textContent).toContain('Keep your saved history');
    await act(async () => vi.advanceTimersByTime(120000));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.every(
        ([url, options]) =>
          url === '/api/marketplace/owned-wallets' && !options?.method,
      ),
    ).toBe(true);
    expect(
      host.querySelector(
        'select, input[type="checkbox"], input[type="password"]',
      ),
    ).toBeNull();
  },
);
it.each([
  'wrong-status',
  'extra-field',
  'wrong-code',
  'arbitrary-message',
] as const)('refuses misleading capacity details: %s', async (mode) => {
  const body = marketplaceInventoryCapacityBody(
    new MarketplaceInventoryCapacityError('saved-history-run-limit'),
  );
  const changed =
    mode === 'extra-field'
      ? { ...body, wallets: [] }
      : mode === 'wrong-code'
        ? { ...body, errorCode: 'unsupported' }
        : mode === 'arbitrary-message'
          ? { ...body, error: 'private server details' }
          : body;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(changed, { status: mode === 'wrong-status' ? 503 : 409 }),
    ),
  );
  await mount();
  await click('Load my inventory');
  expect(host.textContent).not.toContain('bounded history pagination');
  expect(host.textContent).not.toContain('private server details');
  expect(host.querySelectorAll('li')).toHaveLength(0);
});
it('discards a late capacity response after cancellation and permits only an explicit new read', async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce(Response.json(result()));
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Load my inventory');
  await click('Cancel inventory read');
  await click('Load my inventory');
  await act(async () =>
    resolve(
      Response.json(
        marketplaceInventoryCapacityBody(
          new MarketplaceInventoryCapacityError('saved-history-run-limit'),
        ),
        { status: 409 },
      ),
    ),
  );
  expect(host.textContent).not.toContain('bounded history pagination');
  expect(host.querySelectorAll('li').length).toBeGreaterThan(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
async function field(label: string, value: string) {
  const el = [...host.querySelectorAll('label')]
    .find((l) => l.textContent?.startsWith(label))!
    .querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('loads owned evidence only on click and keeps age, receipts and sale blockers separate', async () => {
  const fetcher = vi.fn(async () => Response.json(result()));
  vi.stubGlobal('fetch', fetcher);
  await mount();
  expect(fetcher).not.toHaveBeenCalled();
  await click('Load my inventory');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe(
    '/api/marketplace/owned-wallets',
  );
  expect(host.textContent).toContain('30 days since a recorded activity');
  expect(host.textContent).toContain('First funding / creation date');
  expect(host.textContent).toContain('Listing is not available yet');
  expect(host.textContent).toContain('5 entries, 5 unique recorded signatures');
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(
    [...host.querySelectorAll('button')].some((b) =>
      /^(Buy|Sell|List wallet|Sign)/.test(b.textContent ?? ''),
    ),
  ).toBe(false);
});
it('filters locally and never treats missing dates as old inventory', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(result())),
  );
  await mount();
  await click('Load my inventory');
  await field('Minimum observed activity age', '30');
  expect(host.querySelectorAll('li')).toHaveLength(1);
  await field('Minimum observed activity age', '31');
  expect(host.querySelectorAll('li')).toHaveLength(0);
  expect(host.textContent).toContain('No saved wallets match');
  await field('Minimum observed activity age', '');
  await field('Search wallets', 'Inventory B');
  expect(host.querySelectorAll('li')).toHaveLength(1);
  expect(host.querySelector('li')?.textContent).toContain('Not established');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('refuses invalid age input without a request', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(result())),
  );
  await mount();
  await click('Load my inventory');
  await field('Minimum observed activity age', '-1');
  expect(host.querySelector('[aria-invalid="true"]')).not.toBeNull();
  expect(host.querySelectorAll('li')).toHaveLength(0);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('expires the inventory view without refreshing automatically', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(result())),
  );
  await mount();
  await click('Load my inventory');
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(host.textContent).toContain('Inventory view expired');
  expect(host.querySelectorAll('li')).toHaveLength(0);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('cancels a pending request and ignores its late response', async () => {
  let finish!: (r: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  await mount();
  await click('Load my inventory');
  await click('Cancel inventory read');
  await act(async () => finish(Response.json(result())));
  expect(host.textContent).toContain('Inventory read cancelled');
  expect(host.querySelectorAll('li')).toHaveLength(0);
});
it('shows sign-in recovery without probing provider or wallet endpoints', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'signed out' }, { status: 401 })),
  );
  await mount();
  await click('Load my inventory');
  expect(host.querySelector('a[href="/sign-in"]')).not.toBeNull();
  expect(host.querySelectorAll('li')).toHaveLength(0);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(['html', 'authority', 'unexpected'] as const)(
  'sanitizes invalid inventory responses: %s',
  async (kind) => {
    const changed = result();
    if (kind === 'authority') Object.assign(changed, { listingEnabled: true });
    if (kind === 'unexpected')
      Object.assign(changed.wallets[0], { privateKey: 'synthetic-secret' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        kind === 'html'
          ? new Response('<html>private upstream parser</html>', {
              status: 502,
            })
          : Response.json(changed),
      ),
    );
    await mount();
    await click('Load my inventory');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).not.toMatch(
      /private|synthetic-secret|Zod|invalid_type|parser/,
    );
    expect(host.querySelectorAll('li')).toHaveLength(0);
  },
);
it('distinguishes empty owned inventory from failed reads', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ...result(), wallets: [] })),
  );
  await mount();
  await click('Load my inventory');
  expect(host.textContent).toContain('No active saved Solana wallets');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it('pages saved evidence locally without extra API calls', async () => {
  const data = result();
  for (let i = 3; i <= 23; i++)
    data.wallets.push({
      ...data.wallets[1],
      address: bs58.encode(new Uint8Array(32).fill(i)),
      label: `Wallet ${i}`,
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(data)),
  );
  await mount();
  await click('Load my inventory');
  expect(host.querySelectorAll('li')).toHaveLength(20);
  await click('Next inventory page');
  expect(host.querySelectorAll('li')).toHaveLength(3);
  expect(host.textContent).toContain('21 to 23 of 23');
  await click('Previous inventory page');
  expect(host.querySelectorAll('li')).toHaveLength(20);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('switches between catalog and owned inventory without fetching until requested', async () => {
  vi.stubGlobal('fetch', vi.fn());
  await mount(true);
  expect(host.textContent).toContain('Checkout unavailable');
  await click('My inventory');
  expect(
    host.querySelector('[aria-label="My saved wallet inventory"]'),
  ).not.toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  await click('Browse wallets');
  expect(
    host.querySelector('[aria-label="My saved wallet inventory"]'),
  ).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
