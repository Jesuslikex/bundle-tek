// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createHash, randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { marketplacePublicationFixture } from '../test/marketplace-publication-fixture';
import { MarketplaceBundleCatalog } from './marketplace-bundle-catalog';
import { MarketplaceCartReview } from './marketplace-cart-review';
import { reviewMarketplaceCart } from '@/lib/marketplace-cart';
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
  f.catalog.listings.push({
    ...f.catalog.listings[0],
    id: randomUUID(),
    listing: {
      ...f.catalog.listings[0].listing,
      address: f.source.b,
      priceLamports: '25000001',
    },
  });
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
async function mount(ids?: string[]) {
  await act(async () =>
    root.render(
      ids ? (
        <MarketplaceCartReview
          catalog={f.catalog}
          ids={ids}
          hiddenCount={0}
          onRemove={() => {}}
          onClear={() => {}}
        />
      ) : (
        <MarketplaceBundleCatalog />
      ),
    ),
  );
}
function button(text: string) {
  return [...host.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )!;
}
async function click(text: string) {
  await act(async () => button(text).click());
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
function server() {
  return vi.fn(async (url: string, init?: RequestInit) =>
    url === '/api/marketplace/bundle-catalog'
      ? Response.json(f.catalog)
      : Response.json({
          review: await reviewMarketplaceCart(
            JSON.parse(init!.body as string),
            f.catalog,
          ),
        }),
  );
}
it('checks the exact selection with one manual request, exact total and no financial approval controls', async () => {
  const fetcher = server();
  vi.stubGlobal('fetch', fetcher);
  await mount(f.catalog.listings.map((x) => x.id));
  expect(fetcher).not.toHaveBeenCalled();
  expect(host.textContent).toContain('0.075000001 SOL');
  await click('Review selected wallets');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe('/api/marketplace/cart-review');
  expect(host.textContent).toContain('Selection checked · not reserved');
  expect(host.textContent).toContain('Not quoted or included');
  expect(host.textContent).toContain('Solana');
  expect(
    [...host.querySelectorAll('button')].some((b) =>
      /^(Pay|Buy|Sign|Approve)/.test(b.textContent ?? ''),
    ),
  ).toBe(false);
  expect(host.querySelector('input[type="password"]')).toBeNull();
});
it('selects a partial available batch explicitly, preserves hidden selection, and replaces it only on another selection action', async () => {
  const fetcher = server();
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Refresh Bundle inventory');
  await click('Select matching wallets');
  expect(host.textContent).toContain(
    'Only 2 wallets match; selected 2 of the requested 25',
  );
  expect(host.textContent).toContain('Selected wallets · 2');
  await field('Maximum asking price', '0.03');
  expect(host.textContent).toContain('1 selected wallet is outside');
  await click('Review selected wallets');
  expect(
    JSON.parse(fetcher.mock.calls[1][1]!.body as string).items,
  ).toHaveLength(2);
  expect(host.textContent).toContain('Selection checked · not reserved');
  await field('Wallet count', '1');
  await click('Select matching wallets');
  expect(host.textContent).toContain('Selected wallets · 1');
  expect(host.textContent).not.toContain('Selection checked · not reserved');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('refresh removes a withdrawn selection and retains eligible selections without automatically reviewing again', async () => {
  const fetcher = server();
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Refresh Bundle inventory');
  await click('Select matching wallets');
  f.catalog = { ...f.catalog, listings: [f.catalog.listings[1]] };
  await click('Refresh Bundle inventory');
  expect(host.textContent).toContain(
    '1 previously selected wallet is no longer available',
  );
  expect(host.textContent).toContain('Selected wallets · 1');
  expect(
    (host.querySelector('input[type="checkbox"]') as HTMLInputElement).checked,
  ).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('aborts a pending review and ignores the old response when selection changes', async () => {
  let finish!: (r: Response) => void;
  const fetcher = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Promise<Response>((r) => (finish = r)),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount(f.catalog.listings.map((x) => x.id));
  await click('Review selected wallets');
  const request = JSON.parse(fetcher.mock.calls[0][1]!.body as string),
    response = await reviewMarketplaceCart(request, f.catalog);
  await mount([f.catalog.listings[0].id]);
  expect(fetcher.mock.calls[0][1]!.signal!.aborted).toBe(true);
  await act(async () => finish(Response.json({ review: response })));
  expect(host.textContent).not.toContain('Selection checked · not reserved');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('expires verified reviews but retains selected IDs until a manual refresh, without polling', async () => {
  const fetcher = server();
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Refresh Bundle inventory');
  await click('Select matching wallets');
  await click('Review selected wallets');
  expect(host.textContent).toContain('Selection checked · not reserved');
  await act(async () => vi.advanceTimersByTime(60000));
  expect(host.textContent).not.toContain('Selection checked · not reserved');
  expect(host.textContent).toContain('Catalog view expired');
  expect(host.textContent).toContain('Selected wallets · 2');
  expect(button('Review selected wallets').disabled).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
  f.catalog = {
    ...f.catalog,
    observedAt: new Date(now + 60000).toISOString(),
    expiresAt: new Date(now + 120000).toISOString(),
  };
  await click('Refresh Bundle inventory');
  expect(host.textContent).toContain('Selected wallets · 2');
  expect(button('Review selected wallets').disabled).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it('cancels an old snapshot review even when selected IDs and observation times are unchanged', async () => {
  let finish!: (r: Response) => void;
  const fetcher = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Promise<Response>((r) => (finish = r)),
  );
  vi.stubGlobal('fetch', fetcher);
  const ids = f.catalog.listings.map((x) => x.id);
  await mount(ids);
  await click('Review selected wallets');
  const init = fetcher.mock.calls[0][1]!,
    response = await reviewMarketplaceCart(
      JSON.parse(init.body as string),
      f.catalog,
    );
  f.catalog = {
    ...f.catalog,
    listings: f.catalog.listings.map((entry, i) =>
      i
        ? entry
        : {
            ...entry,
            listing: { ...entry.listing, priceLamports: '1' },
          },
    ),
  };
  await mount(ids);
  expect(init.signal!.aborted).toBe(true);
  expect(button('Review selected wallets').disabled).toBe(false);
  await act(async () => finish(Response.json({ review: response })));
  expect(host.textContent).not.toContain('Selection checked · not reserved');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('cancels a pending cart review and ignores its late response without retrying', async () => {
  let finish!: (r: Response) => void;
  const fetcher = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Promise<Response>((r) => (finish = r)),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount(f.catalog.listings.map((x) => x.id));
  await click('Review selected wallets');
  const init = fetcher.mock.calls[0][1]!,
    review = await reviewMarketplaceCart(
      JSON.parse(init.body as string),
      f.catalog,
    );
  await click('Cancel cart review');
  expect(init.signal!.aborted).toBe(true);
  await act(async () => finish(Response.json({ review })));
  expect(host.textContent).not.toContain('Selection checked · not reserved');
  expect(host.textContent).toContain('Cart review cancelled');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(['price', 'authority', 'html'] as const)(
  'refuses an altered %s cart response',
  async (kind) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (kind === 'html')
          return new Response('<html>private failure</html>', { status: 502 });
        const review = await reviewMarketplaceCart(
          JSON.parse(init!.body as string),
          f.catalog,
        );
        if (kind === 'price') review.askingPriceLamports = '1';
        if (kind === 'authority') Object.assign(review, { reserved: true });
        return Response.json({ review });
      }),
    );
    await mount(f.catalog.listings.map((x) => x.id));
    await click('Review selected wallets');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Selection checked · not reserved');
    expect(host.textContent).not.toContain('private failure');
  },
);
it('shows a useful withdrawal conflict and a sign-in recovery link, with no automatic retry', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({ error: 'changed' }, { status: 409 }),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount(f.catalog.listings.map((x) => x.id));
  await click('Review selected wallets');
  expect(host.textContent).toContain('Refresh inventory');
  fetcher.mockImplementation(async () =>
    Response.json({ error: 'signed out' }, { status: 401 }),
  );
  await click('Review selected wallets');
  expect(host.querySelector('a[href="/sign-in"]')).not.toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('caps selected wallets at 200 across pages and explains invalid count choices', async () => {
  for (let i = 3; i <= 201; i++)
    f.catalog.listings.push({
      ...f.catalog.listings[0],
      id: randomUUID(),
      listing: {
        ...f.catalog.listings[0].listing,
        address: bs58.encode(new Uint8Array(32).fill(i)),
      },
    });
  vi.stubGlobal('fetch', server());
  await mount();
  await click('Refresh Bundle inventory');
  await field('Wallet count', '201');
  expect(button('Select matching wallets').disabled).toBe(true);
  const countInput = [...host.querySelectorAll('label')]
    .find((l) => l.textContent?.startsWith('Wallet count'))!
    .querySelector('input')!;
  expect(countInput.getAttribute('aria-invalid')).toBe('true');
  expect(
    countInput
      .getAttribute('aria-describedby')
      ?.split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' '),
  ).toContain('Choose a wallet count from 1 to 200');
  await click('200');
  expect(countInput.getAttribute('aria-invalid')).toBe('false');
  await click('Select matching wallets');
  expect(host.textContent).toContain('Selected wallets · 200');
  expect(host.textContent).toContain('Maximum 200 wallets selected');
  await click('Next catalog page');
  expect(host.textContent).toContain('Selected wallets · 200');
});

it.each([25, 50, 100, 200])(
  'sets the %s-wallet preset locally and selects only after the explicit action',
  async (count) => {
    const fetcher = server();
    vi.stubGlobal('fetch', fetcher);
    await mount();
    await click('Refresh Bundle inventory');
    await click(String(count));
    expect(button(String(count)).getAttribute('aria-pressed')).toBe('true');
    expect(host.textContent).not.toContain('Selected wallets ·');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await click('Select matching wallets');
    expect(host.textContent).toContain(
      `Only 2 wallets match; selected 2 of the requested ${count}`,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(host.querySelector('input[type="password"]')).toBeNull();
  },
);

it('keeps the exact reviewed selection when changing the desired count and supports a custom value afterwards', async () => {
  const fetcher = server();
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Refresh Bundle inventory');
  await click('Select matching wallets');
  await click('Review selected wallets');
  await click('100');
  expect(host.textContent).toContain('Selected wallets · 2');
  expect(host.textContent).not.toContain(
    'Only 2 wallets match; selected 2 of the requested 25',
  );
  expect(host.textContent).toContain('Selection checked · not reserved');
  expect(fetcher).toHaveBeenCalledTimes(2);
  await field('Wallet count', '1');
  for (const count of [25, 50, 100, 200])
    expect(button(String(count)).getAttribute('aria-pressed')).toBe('false');
  await click('Select matching wallets');
  expect(host.textContent).toContain('Selected wallets · 1');
  expect(host.textContent).not.toContain('Selection checked · not reserved');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
