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
