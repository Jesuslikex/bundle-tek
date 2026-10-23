// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createHash, randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { marketplacePublicationFixture } from '../test/marketplace-publication-fixture';
import { MarketplaceBundleCatalog } from './marketplace-bundle-catalog';
let root: Root,
  host: HTMLDivElement,
  f: Awaited<ReturnType<typeof marketplacePublicationFixture>>;
const now = Date.parse('2026-10-20T12:00:00Z');
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', {
    randomUUID,
    subtle: {
      digest: async (_algorithm: string, bytes: Uint8Array) =>
        Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer,
    },
  });
  f = await marketplacePublicationFixture(now);
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
async function mount() {
  await act(async () => root.render(<MarketplaceBundleCatalog />));
}
async function click(text: string) {
  const b = [...host.querySelectorAll('button')].find(
    (e) => e.textContent === text,
  )!;
  await act(async () => b.click());
}
async function field(label: string, value: string) {
  const input = [...host.querySelectorAll('label')]
    .find((l) => l.textContent?.startsWith(label))!
    .querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('loads only Bundle inventory on request with honest age/balance units and no purchase control', async () => {
  const fetcher = vi.fn(async (_url: string) => Response.json(f.catalog));
  vi.stubGlobal('fetch', fetcher);
  await mount();
  expect(fetcher).not.toHaveBeenCalled();
  await click('Refresh Bundle inventory');
  expect(fetcher.mock.calls[0][0]).toBe('/api/marketplace/bundle-catalog');
  expect(host.querySelectorAll('li')).toHaveLength(1);
  expect(host.textContent).toContain('0.05 SOL');
  expect(host.textContent).toContain('Historical balance');
  expect(host.textContent).toContain('not wallet creation or funding age');
  expect(
    [...host.querySelectorAll('button')].some((b) =>
      /^(Buy|Pay|Sign)/.test(b.textContent ?? ''),
    ),
  ).toBe(false);
});
it('filters observed activity and exact asking price locally without treating unknown dates as aged', async () => {
  f.catalog.listings.push({
    ...f.catalog.listings[0],
    id: randomUUID(),
    listing: {
      ...f.catalog.listings[0].listing,
      address: f.source.b,
      oldestRecordedActivityAt: null,
      priceLamports: '1',
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(f.catalog)),
  );
  await mount();
  await click('Refresh Bundle inventory');
  await field('Minimum recorded activity age', '1');
  expect(host.querySelectorAll('li')).toHaveLength(1);
  await field('Maximum asking price', '0.049999999');
  expect(host.querySelectorAll('li')).toHaveLength(0);
  await field('Maximum asking price', '0.05');
  expect(host.querySelectorAll('li')).toHaveLength(1);
  await field('Minimum recorded activity age', '31');
  expect(host.querySelectorAll('li')).toHaveLength(0);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('pages locally and expires without refreshing automatically', async () => {
  for (let i = 2; i <= 23; i++)
    f.catalog.listings.push({
      ...f.catalog.listings[0],
      id: randomUUID(),
      listing: {
        ...f.catalog.listings[0].listing,
        address: bs58.encode(new Uint8Array(32).fill(i)),
      },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(f.catalog)),
  );
  await mount();
  await click('Refresh Bundle inventory');
  expect(host.querySelectorAll('li')).toHaveLength(20);
  await click('Next catalog page');
  expect(host.querySelectorAll('li')).toHaveLength(3);
  await act(async () => vi.advanceTimersByTime(60000));
  expect(host.querySelectorAll('li')).toHaveLength(0);
  expect(host.textContent).toContain('Catalog view expired');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(['authority', 'private', 'html'] as const)(
  'refuses malformed %s catalog responses',
  async (kind) => {
    if (kind === 'authority')
      Object.assign(f.catalog, { purchaseEnabled: true });
    if (kind === 'private')
      Object.assign(f.catalog.listings[0], { owner_id: 'operator' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        kind === 'html'
          ? new Response('<html>private failure</html>', { status: 502 })
          : Response.json(f.catalog),
      ),
    );
    await mount();
    await click('Refresh Bundle inventory');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.querySelectorAll('li')).toHaveLength(0);
    expect(host.textContent).not.toContain('private failure');
  },
);
it('shows a sign-in link and distinguishes empty inventory from unavailable storage', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({ error: 'signed out' }, { status: 401 }),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Refresh Bundle inventory');
  expect(host.querySelector('a[href="/sign-in"]')).not.toBeNull();
  fetcher.mockImplementation(async () =>
    Response.json({ ...f.catalog, listings: [] }),
  );
  await click('Refresh Bundle inventory');
  expect(host.textContent).toContain('No published Bundle wallets');
});

it('filters published history locally and retains selected wallets outside the new filters', async () => {
  const original = f.catalog.listings[0];
  f.catalog.listings.push({
    ...original,
    id: randomUUID(),
    listing: {
      ...original.listing,
      address: f.source.b,
      historicalBalance: null,
      oldestRecordedActivityAt: null,
      savedHistoryChecks: 0,
      warmupUniqueSignatures: 0,
    },
  });
  const fetcher = vi.fn(async () => Response.json(f.catalog));
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Refresh Bundle inventory');
  const selectedAddress = original.listing.address;
  await act(async () =>
    (
      host.querySelector(
        `input[aria-label="Select ${selectedAddress}"]`,
      ) as HTMLInputElement
    ).click(),
  );
  await field('Exact wallet address', f.source.b);
  expect(host.querySelectorAll('ul[data-view] > li')).toHaveLength(1);
  expect(host.textContent).toContain('outside the current filters');
  expect(
    host.querySelector('section[aria-label="Selected wallet cart"] h2')
      ?.textContent,
  ).toMatch(/Selected wallets.*1$/);
  await field('Minimum historical balance', '0');
  expect(host.querySelectorAll('ul[data-view] > li')).toHaveLength(0);
  await click('Clear catalog filters');
  expect(
    (
      host.querySelector(
        `input[aria-label="Select ${selectedAddress}"]`,
      ) as HTMLInputElement
    ).checked,
  ).toBe(true);
  expect(host.querySelectorAll('ul[data-view] > li')).toHaveLength(2);
  await field('Maximum recorded activity age', '0');
  expect(host.querySelectorAll('ul[data-view] > li')).toHaveLength(0);
  await click('Clear catalog filters');
  await field(
    'Minimum saved history checks',
    String(original.listing.savedHistoryChecks + 1),
  );
  expect(host.querySelectorAll('ul[data-view] > li')).toHaveLength(0);
  await click('Clear catalog filters');
  await field(
    'Minimum recorded warmup signatures',
    String(original.listing.warmupUniqueSignatures + 1),
  );
  expect(host.querySelectorAll('ul[data-view] > li')).toHaveLength(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('not total transactions');
});

it('resets local pagination on search and shows invalid range reasons without losing selection', async () => {
  for (let i = 2; i < 24; i++)
    f.catalog.listings.push({
      ...f.catalog.listings[0],
      id: randomUUID(),
      listing: {
        ...f.catalog.listings[0].listing,
        address: bs58.encode(new Uint8Array(32).fill(i)),
      },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(f.catalog)),
  );
  await mount();
  await click('Refresh Bundle inventory');
  await click('Next catalog page');
  await field('Exact wallet address', f.catalog.listings[0].listing.address);
  expect(host.querySelectorAll('ul[data-view] > li')).toHaveLength(1);
  expect(host.textContent).toContain('1 to 1 of 1');
  await field('Minimum historical balance', '2');
  await field('Maximum historical balance', '1');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Maximum bounds',
  );
  expect(
    [...host.querySelectorAll('button')].find(
      (e) => e.textContent === 'Select matching wallets',
    )?.disabled,
  ).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('replaces a hidden selection only through explicit matching selection and refuses it after expiry', async () => {
  const original = f.catalog.listings[0];
  f.catalog.listings.push({
    ...original,
    id: randomUUID(),
    listing: { ...original.listing, address: f.source.b },
  });
  const fetcher = vi.fn(async () => Response.json(f.catalog));
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Refresh Bundle inventory');
  await act(async () =>
    (
      host.querySelector(
        `input[aria-label="Select ${original.listing.address}"]`,
      ) as HTMLInputElement
    ).click(),
  );
  await field('Exact wallet address', f.source.b);
  await field('Wallet count', '2');
  expect(host.textContent).toContain('outside the current filters');
  await click('Select matching wallets');
  expect(host.textContent).toContain(
    'Only 1 wallet matches; selected 1 of the requested 2.',
  );
  expect(host.textContent).not.toContain('outside the current filters');
  expect(
    (
      host.querySelector(
        `input[aria-label="Select ${f.source.b}"]`,
      ) as HTMLInputElement
    ).checked,
  ).toBe(true);
  await act(async () => vi.advanceTimersByTime(60000));
  await field('Minimum historical balance', '0');
  const choose = [...host.querySelectorAll('button')].find(
    (e) => e.textContent === 'Select matching wallets',
  )!;
  expect(choose.disabled).toBe(true);
  expect(host.textContent).toContain(
    'Selection retained as an unverified draft',
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(['replace', 'add'] as const)(
  'refuses an expired %s selection when the browser expiry timer has not fired',
  async (action) => {
    const original = f.catalog.listings[0];
    f.catalog.listings.push({
      ...original,
      id: randomUUID(),
      listing: { ...original.listing, address: f.source.b },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(f.catalog)),
    );
    await mount();
    await click('Refresh Bundle inventory');
    const checkbox = (address: string) =>
      host.querySelector(
        `input[aria-label="Select ${address}"]`,
      ) as HTMLInputElement;
    await act(async () => checkbox(original.listing.address).click());
    vi.setSystemTime(now + 60001); // No timer advancement: the rendered controls still look enabled.
    if (action === 'replace') await click('Select matching wallets');
    else await act(async () => checkbox(f.source.b).click());
    expect(checkbox(original.listing.address).checked).toBe(true);
    expect(checkbox(f.source.b).checked).toBe(false);
    expect(host.textContent).toContain('Catalog view expired');
    expect(checkbox(original.listing.address).disabled).toBe(false);
    await act(async () => checkbox(original.listing.address).click());
    expect(
      host.querySelector('[aria-label="Selected wallet cart"]'),
    ).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it('keeps selection across pagination and historical-balance sort changes', async () => {
  for (let i = 2; i < 24; i++)
    f.catalog.listings.push({
      ...f.catalog.listings[0],
      id: randomUUID(),
      listing: {
        ...f.catalog.listings[0].listing,
        address: bs58.encode(new Uint8Array(32).fill(i)),
        historicalBalance: {
          observedAt: f.catalog.observedAt,
          balanceLamports: String(i),
          sampleCount: 1,
          successfulSampleCount: 1,
        },
      },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(f.catalog)),
  );
  await mount();
  await click('Refresh Bundle inventory');
  const selected = host.querySelector(
    'ul[data-view] input[type="checkbox"]',
  ) as HTMLInputElement;
  const label = selected.getAttribute('aria-label');
  await act(async () => selected.click());
  await click('Next catalog page');
  expect(host.textContent).toContain('21 to 23 of 23');
  const sort = host.querySelector('select')!;
  await act(async () => {
    sort.value = 'balance-high';
    sort.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.textContent).toContain('1 to 20 of 23');
  await click('Next catalog page');
  await act(async () => {
    sort.value = 'balance-low';
    sort.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.textContent).toContain('1 to 20 of 23');
  const selectedCheckbox = () =>
    host.querySelector(
      `input[aria-label="${label}"]`,
    ) as HTMLInputElement | null;
  if (!selectedCheckbox()) await click('Next catalog page');
  expect(selectedCheckbox()?.checked).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});
