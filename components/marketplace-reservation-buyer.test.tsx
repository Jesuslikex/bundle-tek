// @vitest-environment jsdom
import { act, useContext } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { marketplacePublicationFixture } from '../test/marketplace-publication-fixture';
import {
  buildCartRequest,
  reviewMarketplaceCart,
  type CartReview,
} from '@/lib/marketplace-cart';
import {
  makeReservation,
  reservationState,
  RESERVATION_ACK,
  RESERVATION_CANCEL_ACK,
  type ReservationRecord,
} from '@/lib/marketplace-reservation';
import { MarketplaceReservationBuyer } from './marketplace-reservation-buyer';
import { MarketplaceReservationContext } from './marketplace-reservation-context';
import { MarketplaceBundleCatalog } from './marketplace-bundle-catalog';
import type { ReservationHistoryPage } from '@/lib/marketplace-reservation-history';
let root: Root,
  host: HTMLDivElement,
  review: CartReview,
  saved: ReservationRecord | null,
  releasedAt: string | null;
const key = 'bundle.marketplace.reservation-id.v1',
  now = Date.parse('2026-10-20T12:00:00Z');
function Launch() {
  const open = useContext(MarketplaceReservationContext);
  return (
    <button onClick={() => open?.open(review)}>Fixture hold review</button>
  );
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', {
    randomUUID,
    subtle: {
      digest: async (_a: string, bytes: Uint8Array) =>
        Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer,
    },
  });
  sessionStorage.clear();
  saved = null;
  releasedAt = null;
  const f = await marketplacePublicationFixture(now);
  review = await reviewMarketplaceCart(
    await buildCartRequest(
      f.catalog,
      f.catalog.listings.map((e) => e.id),
      now,
    ),
    f.catalog,
    now,
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount() {
  await act(async () =>
    root.render(
      <MarketplaceReservationBuyer>
        <Launch />
      </MarketplaceReservationBuyer>,
    ),
  );
}
function button(label: string) {
  return [...document.querySelectorAll('button')].find(
    (e) => e.textContent === label,
  )!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function check(text: string) {
  const input = [...document.querySelectorAll('label')]
    .find((l) => l.textContent === text)!
    .querySelector('input')!;
  await act(async () => input.click());
}
function response() {
  return Response.json({
    reservation: {
      record: saved,
      releasedAt,
      state: reservationState(saved!, releasedAt),
    },
  });
}
/** Everything except the settle POST. The terms read counts too. */
function holds(fetcher: ReturnType<typeof server>) {
  return fetcher.mock.calls.filter(([, init]) => {
    const body = init?.body;
    return (
      typeof body !== 'string' ||
      (JSON.parse(body) as { action?: string }).action !== 'settle'
    );
  }).length;
}
function server() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const { action, ...payload } = JSON.parse(init.body as string);
      if (action === 'reserve') saved = await makeReservation(payload);
      else if (action === 'release') releasedAt = new Date().toISOString();
      else if (action === 'settle')
        return Response.json({ settled: { walletCount: 1 } });
    }
    return response();
  });
}
it('requires fresh separate hold and release approvals, preserves exact totals and never exposes payment controls', async () => {
  const fetcher = server();
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Fixture hold review');
  expect(holds(fetcher)).toBe(0);
  expect(button('Hold these wallets').disabled).toBe(true);
  expect(document.body.textContent).toContain('0.05 SOL');
  await check(RESERVATION_ACK);
  await click('Hold these wallets');
  expect(holds(fetcher)).toBe(1);
  expect(document.body.textContent).toContain('Held · payment unavailable');
  const payload = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
  expect(payload.review).toEqual(review);
  expect(sessionStorage.getItem(key)).toBe(saved!.id);
  const recoveryInput = document.querySelector(
    'input[readonly]',
  ) as HTMLInputElement;
  expect(recoveryInput.value).toBe(saved!.id);
  expect(recoveryInput.disabled).toBe(false);
  expect(button('Release this hold').disabled).toBe(true);
  expect(
    [...document.querySelectorAll('button')].some((b) =>
      /^(Pay|Buy|Sign|Deliver)\b/.test(b.textContent || ''),
    ),
  ).toBe(false);
  await check(RESERVATION_CANCEL_ACK);
  await click('Release this hold');
  expect(holds(fetcher)).toBe(2);
  expect(document.body.textContent).toContain('Hold released.');
  await click('Clear local recovery ID');
  expect(sessionStorage.getItem(key)).toBeNull();
});
it('retains the exact unknown-write ID across remount and only recovers manually without another POST', async () => {
  const fetcher = server();
  fetcher.mockImplementationOnce(async (_url, init) => {
    const { action: _action, ...payload } = JSON.parse(init!.body as string);
    saved = await makeReservation(payload);
    throw Error('Lost response');
  });
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Fixture hold review');
  await check(RESERVATION_ACK);
  await click('Hold these wallets');
  const id = sessionStorage.getItem(key);
  expect(id).toBe(saved!.id);
  expect(document.body.textContent).toContain('Recover this same ID');
  await act(async () => root.unmount());
  root = createRoot(host);
  await mount();
  await click('Recover wallet hold');
  expect(holds(fetcher)).toBe(1);
  await click('Recover this hold');
  expect(holds(fetcher)).toBe(2);
  expect(fetcher.mock.calls[1][0]).toContain(id!);
  expect(fetcher.mock.calls[1][1]?.method).not.toBe('POST');
  expect(document.body.textContent).toContain('Held · payment unavailable');
  expect(button('Release this hold').disabled).toBe(true);
});
it.each(['id', 'payment', 'state', 'html'] as const)(
  'refuses a changed %s result and requires manual recovery',
  async (kind) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const { action: _action, ...payload } = JSON.parse(
          init!.body as string,
        );
        saved = await makeReservation(payload);
        if (kind === 'html')
          return new Response('<html>private failure</html>', { status: 502 });
        const record = structuredClone(saved);
        if (kind === 'id') record.id = crypto.randomUUID();
        if (kind === 'payment') Object.assign(record, { paymentEnabled: true });
        return Response.json({
          reservation: {
            record,
            releasedAt: null,
            state: kind === 'state' ? 'released' : 'held',
          },
        });
      }),
    );
    await mount();
    await click('Fixture hold review');
    await check(RESERVATION_ACK);
    await click('Hold these wallets');
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('private failure');
    expect(button('Release this hold')).toBeUndefined();
    expect(sessionStorage.getItem(key)).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
it('expires the review before any write and expires a held receipt locally without polling', async () => {
  const fetcher = server();
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Fixture hold review');
  await check(RESERVATION_ACK);
  await act(async () => vi.advanceTimersByTime(60000));
  expect(button('Hold these wallets').disabled).toBe(true);
  expect(holds(fetcher)).toBe(0);
  await click('Close hold window');
  vi.setSystemTime(now);
  await click('Fixture hold review');
  await check(RESERVATION_ACK);
  await click('Hold these wallets');
  await act(async () => vi.advanceTimersByTime(300000));
  expect(button('Release this hold')).toBeUndefined();
  expect(document.body.textContent).toContain('Expired');
  expect(holds(fetcher)).toBe(1);
});
it('stops waiting, aborts the request and ignores late committed results without another write', async () => {
  let finish!: (r: Response) => void;
  const fetcher = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Promise<Response>((r) => (finish = r)),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Fixture hold review');
  await check(RESERVATION_ACK);
  await click('Hold these wallets');
  const init = fetcher.mock.calls[0][1]!,
    { action: _action, ...payload } = JSON.parse(init.body as string);
  saved = await makeReservation(payload);
  await click('Stop waiting for hold');
  expect(init.signal!.aborted).toBe(true);
  await act(async () => finish(response()));
  expect(document.body.textContent).not.toContain('Held · payment unavailable');
  expect(holds(fetcher)).toBe(1);
  expect(sessionStorage.getItem(key)).toBe(saved.id);
});
it('recovers a release whose response was lost before allowing local cleanup', async () => {
  const fetcher = server();
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Fixture hold review');
  await check(RESERVATION_ACK);
  await click('Hold these wallets');
  fetcher.mockImplementationOnce(async () => {
    releasedAt = new Date().toISOString();
    throw Error('Lost release');
  });
  await check(RESERVATION_CANCEL_ACK);
  await click('Release this hold');
  expect(button('Release this hold')).toBeUndefined();
  expect(button('Clear local recovery ID')).toBeUndefined();
  await click('Recover this hold');
  expect(document.body.textContent).toContain('Hold released.');
  expect(holds(fetcher)).toBe(3);
});
it('requires recovery of a retained ID and handles sign-out without creating a second hold', async () => {
  sessionStorage.setItem(key, crypto.randomUUID());
  const fetcher = vi.fn(async () =>
    Response.json({ error: 'signed out' }, { status: 401 }),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Fixture hold review');
  expect(button('Hold these wallets')).toBeUndefined();
  expect(holds(fetcher)).toBe(0);
  await click('Recover this hold');
  expect(document.querySelector('a[href="/sign-in"]')).not.toBeNull();
  expect(button('Clear local recovery ID')).toBeUndefined();
  expect(holds(fetcher)).toBe(1);
});
it.each([false, true])(
  'invalidates background availability on a hold attempt, including unknown outcome %s',
  async (lost) => {
    const f = await marketplacePublicationFixture(now);
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/marketplace/bundle-catalog')
        return Response.json(f.catalog);
      if (url === '/api/marketplace/cart-review')
        return Response.json({
          review: await reviewMarketplaceCart(
            JSON.parse(init!.body as string),
            f.catalog,
          ),
        });
      const { action: _action, ...payload } = JSON.parse(init!.body as string);
      saved = await makeReservation(payload);
      if (lost) throw Error('Lost hold result');
      return response();
    });
    vi.stubGlobal('fetch', fetcher);
    await act(async () =>
      root.render(
        <MarketplaceReservationBuyer>
          <MarketplaceBundleCatalog />
        </MarketplaceReservationBuyer>,
      ),
    );
    await click('Refresh Bundle inventory');
    await click('Select matching wallets');
    await click('Review selected wallets');
    await click('Review wallet hold');
    await check(RESERVATION_ACK);
    await click('Hold these wallets');
    await click('Close hold window');
    expect(host.textContent).toContain(
      'A wallet hold may have changed availability',
    );
    expect(host.textContent).not.toContain('Selection checked · not reserved');
    expect(button('Review selected wallets').disabled).toBe(true);
    expect(holds(fetcher)).toBe(3);
  },
);
function historyPage(records: ReservationRecord[]): ReservationHistoryPage {
  return {
    format: 'bundle-reservation-history-v1',
    chain: 'Solana',
    seller: 'Bundle',
    observedAt: new Date().toISOString(),
    entries: records.map((record) => ({
      id: record.id,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      releasedAt: null,
      state: 'held',
      count: record.review.count,
      askingPriceLamports: record.review.askingPriceLamports,
      contextSha256: record.contextSha256,
    })),
    nextCursor: null,
    reserveAllowed: false,
    releaseAllowed: false,
    purchaseEnabled: false,
    paymentEnabled: false,
    deliveryEnabled: false,
    signingAllowed: false,
  };
}
it('discovers a saved hold without a local ID, then recovers its full receipt before showing release consent', async () => {
  saved = await makeReservation(
    { id: crypto.randomUUID(), review, acknowledgement: RESERVATION_ACK },
    now,
  );
  const page = historyPage([saved]),
    fetcher = vi.fn(async (url: string, _init?: RequestInit) =>
      url.includes('history=1') ? Response.json({ history: page }) : response(),
    );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Recover wallet hold');
  expect(holds(fetcher)).toBe(0);
  await click('Find my saved holds');
  expect(document.body.textContent).toContain('Saved wallet holds');
  expect(document.body.textContent).not.toContain(
    review.items[0].listing.address,
  );
  expect(button('Release this hold')).toBeUndefined();
  expect(sessionStorage.getItem(key)).toBeNull();
  await click('Open hold');
  expect(
    document.querySelector('section[aria-label="Saved wallet holds"]'),
  ).toBeNull();
  expect(holds(fetcher)).toBe(2);
  expect(fetcher.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(
    true,
  );
  expect(button('Release this hold').disabled).toBe(true);
  expect(sessionStorage.getItem(key)).toBe(saved.id);
});
it.each(['authority', 'html'] as const)(
  'refuses malformed %s history without saving an ID or granting an action',
  async (kind) => {
    const page = historyPage([]);
    Object.assign(page, { releaseAllowed: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        kind === 'html'
          ? new Response('<html>private detail</html>', { status: 502 })
          : Response.json({ history: page }),
      ),
    );
    await mount();
    await click('Recover wallet hold');
    await click('Find my saved holds');
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('private detail');
    expect(button('Open hold')).toBeUndefined();
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
it('pages saved summaries manually without automatically recovering or writing a hold', async () => {
  const one = await makeReservation(
      { id: crypto.randomUUID(), review, acknowledgement: RESERVATION_ACK },
      now,
    ),
    first = historyPage([one]);
  first.entries = Array.from({ length: 20 }, (_, i) => ({
    ...first.entries[0],
    id: crypto.randomUUID(),
    createdAt: new Date(now - i * 1000).toISOString(),
    expiresAt: new Date(now - i * 1000 + 300000).toISOString(),
  }));
  const last = first.entries[19];
  first.nextCursor = { id: last.id, createdAt: last.createdAt };
  const second = {
    ...first,
    entries: [
      {
        ...first.entries[0],
        id: crypto.randomUUID(),
        createdAt: new Date(now - 21000).toISOString(),
        expiresAt: new Date(now - 21000 + 300000).toISOString(),
      },
    ],
    nextCursor: null,
  };
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) =>
    Response.json({ history: url.includes('beforeId=') ? second : first }),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Recover wallet hold');
  await click('Find my saved holds');
  expect(
    document.querySelectorAll('button[aria-label^="Open saved hold"]'),
  ).toHaveLength(20);
  await click('Older saved holds');
  expect(
    document.querySelectorAll('button[aria-label^="Open saved hold"]'),
  ).toHaveLength(1);
  expect(fetcher.mock.calls[1][0]).toContain(
    encodeURIComponent(last.createdAt),
  );
  await click('Latest saved holds');
  expect(holds(fetcher)).toBe(3);
  expect(fetcher.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(
    true,
  );
  expect(sessionStorage.getItem(key)).toBeNull();
});

it('offers the reviewed payment after a hold instead of pretending it is a purchase', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const { action, ...payload } = JSON.parse(init.body as string);
      if (action === 'reserve') saved = await makeReservation(payload);
      // A hold is not a purchase: settle refuses until the buyer pays.
      if (action === 'settle')
        return Response.json({ error: 'Pay first.' }, { status: 409 });
    }
    const base = (await response().json()) as { reservation: unknown };
    return Response.json({
      ...base,
      payment: {
        sellerWallet: 'So11111111111111111111111111111111111111112',
        lamports: '50000000',
        paidAt: null,
      },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Fixture hold review');
  await check(RESERVATION_ACK);
  await click('Hold these wallets');
  // The settle POST and the follow-up terms read are two chains deep; poll for
  // the block instead of guessing a tick count.
  for (let i = 0; i < 40; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
    if (document.body.textContent?.includes('Pay the reviewed total')) break;
  }
  console.log('BODY', document.body.textContent);
  expect(document.body.textContent).toContain(
    'Pay the reviewed total to make it a purchase',
  );
  expect(document.body.textContent).toContain('0.05 SOL');
  expect(document.body.textContent).toContain(
    'So11111111111111111111111111111111111111112',
  );
  const pay = [...document.querySelectorAll('button')].find(
    (b) => b.textContent === 'Pay and import',
  )!;
  expect(pay).toBeDefined();
  expect(pay.disabled).toBe(true);
});