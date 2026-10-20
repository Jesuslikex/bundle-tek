// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { MarketplaceOperatorDrafts } from './marketplace-operator-drafts';
import { marketplaceOwnedFixture } from '../test/marketplace-owned-fixture';
import { buildMarketplaceOwnedInventory } from '@/lib/marketplace-owned-inventory';
import {
  reviewOperatorListing,
  type OperatorListingReview,
} from '@/lib/marketplace-operator-review';
import {
  operatorDraftCanonical as canonical,
  operatorDraftRequest,
  type OperatorDraftSave,
  type OperatorDraftRecord,
} from '@/lib/marketplace-operator-draft-view';
const now = Date.parse('2026-10-20T12:00:00Z'),
  key = 'bundle:operator-draft-recovery:v1';
let root: Root, host: HTMLDivElement, review: OperatorListingReview;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  sessionStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', {
    randomUUID,
    subtle: {
      digest: async (_algorithm: string, bytes: Uint8Array) =>
        Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer,
    },
  });
  const inventory = buildMarketplaceOwnedInventory(
    marketplaceOwnedFixture(now).sources,
    now,
  );
  review = await reviewOperatorListing(
    inventory,
    {
      address: inventory.wallets[0].address,
      walletRevision: 2,
      priceLamports: '50000000',
    },
    now,
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount(value: OperatorListingReview | null = review) {
  await act(async () =>
    root.render(<MarketplaceOperatorDrafts review={value} />),
  );
}
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
async function click(text: string) {
  await act(async () => button(text).click());
}
async function check() {
  await act(async () =>
    (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
  );
}
async function recoveryId(value: string) {
  await act(async () => {
    const input = host.querySelector('input[maxlength="36"]')!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function record(input: OperatorDraftSave): OperatorDraftRecord {
  return {
    format: 'bundle-operator-draft-v1',
    id: input.id,
    createdAt: new Date(now).toISOString(),
    sourceObservedAt: new Date(now).toISOString(),
    acknowledgement: input.acknowledgement,
    review: structuredClone(review),
    reviewSha256: createHash('sha256').update(canonical(review)).digest('hex'),
    publicationAllowed: false,
    paymentAllowed: false,
    deliveryAllowed: false,
    signingAllowed: false,
  };
}
it('starts unchecked, saves only the exact acknowledged draft and prevents a duplicate save of that review', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    Response.json({ draft: record(JSON.parse(init!.body as string)) }),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  expect(fetcher).not.toHaveBeenCalled();
  expect(button('Save unpublished draft').disabled).toBe(true);
  await check();
  await click('Save unpublished draft');
  expect(fetcher).toHaveBeenCalledTimes(1);
  const input = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
  expect(input).toEqual(operatorDraftRequest(input.id, review, true));
  expect(sessionStorage.getItem(key)).toBe(JSON.stringify(input));
  expect(host.textContent).toContain('Saved draft snapshot');
  expect(host.textContent).toContain('0.05 SOL');
  expect(button('Save unpublished draft').disabled).toBe(true);
  expect(host.querySelector('input[type="password"]')).toBeNull();
});
it('does not carry acknowledgement into a different review', async () => {
  vi.stubGlobal('fetch', vi.fn());
  await mount();
  await check();
  expect(button('Save unpublished draft').disabled).toBe(false);
  await mount({ ...review, reviewedAt: new Date(now + 1).toISOString() });
  expect(button('Save unpublished draft').disabled).toBe(true);
  expect(
    (host.querySelector('input[type="checkbox"]') as HTMLInputElement).checked,
  ).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
it('keeps an unknown save across remount, sends no automatic request and recovers that same ID after expiry', async () => {
  let retained: OperatorDraftRecord | undefined;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      retained = record(JSON.parse(init.body as string));
      throw Error('lost response');
    }
    return Response.json({ draft: retained });
  });
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await check();
  await click('Save unpublished draft');
  expect(host.textContent).toContain('outcome is unknown');
  expect(button('Clear recovery reminder').disabled).toBe(true);
  await act(async () => root.unmount());
  root = createRoot(host);
  vi.setSystemTime(now + 120000);
  await mount(null);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('recovery ID is available');
  await click('Recover saved draft');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][0]).toContain(retained!.id);
  expect(host.textContent).toContain('Saved draft snapshot');
  expect(host.textContent).toContain('evidence is historical');
  expect(
    fetcher.mock.calls.filter((c) => c[1]?.method === 'POST'),
  ).toHaveLength(1);
});
it('aborts waiting without forgetting the save ID and ignores a late save response', async () => {
  let finish!: (r: Response) => void;
  const fetcher = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Promise<Response>((resolve) => (finish = resolve)),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await check();
  await click('Save unpublished draft');
  const init = fetcher.mock.calls[0][1]!,
    input = JSON.parse(init.body as string);
  await click('Stop waiting');
  expect(init.signal!.aborted).toBe(true);
  expect(sessionStorage.getItem(key)).not.toBeNull();
  await act(async () => finish(Response.json({ draft: record(input) })));
  expect(host.textContent).not.toContain('Saved draft snapshot');
  expect(host.textContent).toContain('may have saved');
});
it('aborts a save on review change but retains the original recovery identity', async () => {
  const fetcher = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Promise<Response>(() => {}),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await check();
  await click('Save unpublished draft');
  const init = fetcher.mock.calls[0][1]!;
  await mount(null);
  expect(init.signal!.aborted).toBe(true);
  expect(sessionStorage.getItem(key)).not.toBeNull();
  expect(host.textContent).toContain('Review changed while saving');
});
it.each(['id', 'price', 'authority', 'html'] as const)(
  'refuses a %s save response and retains the unknown identity',
  async (kind) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const draft = record(JSON.parse(init!.body as string));
        if (kind === 'html')
          return new Response('<html>private failure</html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          });
        if (kind === 'id') draft.id = randomUUID();
        if (kind === 'price') draft.review.selection.priceLamports = '1';
        if (kind === 'authority')
          Object.assign(draft, { publicationAllowed: true });
        return Response.json({ draft });
      }),
    );
    await mount();
    await check();
    await click('Save unpublished draft');
    expect(host.textContent).not.toContain('Saved draft snapshot');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(sessionStorage.getItem(key)).not.toBeNull();
    expect(button('Clear recovery reminder').disabled).toBe(true);
    expect(host.textContent).not.toContain('private failure');
  },
);
it('permits clearing an original reminder only after that exact ID was resolved or not found', async () => {
  const input = operatorDraftRequest(randomUUID(), review, true);
  sessionStorage.setItem(key, JSON.stringify(input));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'not found' }, { status: 404 })),
  );
  await mount();
  await recoveryId(randomUUID());
  await click('Recover saved draft');
  expect(button('Clear recovery reminder').disabled).toBe(true);
  await recoveryId(input.id);
  await click('Recover saved draft');
  expect(button('Clear recovery reminder').disabled).toBe(false);
  await click('Clear recovery reminder');
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(host.textContent).toContain('Saved drafts were not deleted');
});
it('blocks writes when a recovery reminder cannot be persisted', async () => {
  vi.stubGlobal('fetch', vi.fn());
  await mount();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('blocked');
  });
  await check();
  await click('Save unpublished draft');
  expect(fetch).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Nothing was sent');
});
it('does not renew expired review consent or auto-save during recovery', async () => {
  vi.stubGlobal('fetch', vi.fn());
  await mount();
  await check();
  vi.setSystemTime(now + 60000);
  await click('Save unpublished draft');
  expect(fetch).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(key)).toBeNull();
});
