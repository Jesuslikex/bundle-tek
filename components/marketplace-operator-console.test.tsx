// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarketplaceOperatorConsole } from './marketplace-operator-console';
import { marketplaceOwnedFixture } from '../test/marketplace-owned-fixture';
import { buildMarketplaceOwnedInventory } from '@/lib/marketplace-owned-inventory';
import { reviewOperatorListing } from '@/lib/marketplace-operator-review';
let root: Root, host: HTMLDivElement;
const now = Date.parse('2026-10-20T12:00:00Z');
function inventory() {
  return buildMarketplaceOwnedInventory(
    marketplaceOwnedFixture(now).sources,
    now,
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  // Keep real SHA-256 bytes while avoiding worker-pool completion races in UI assertions.
  vi.stubGlobal('crypto', {
    subtle: {
      digest: async (_algorithm: string, bytes: Uint8Array) =>
        Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer,
    },
  });
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
async function mount() {
  await act(async () => root.render(<MarketplaceOperatorConsole />));
}
function button(text: string) {
  return [...host.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )!;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function price(value: string) {
  const input = host.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it.each([401, 403])(
  'requires explicit access and explains denial %s without exposing forms',
  async (status) => {
    const fetcher = vi.fn(async () =>
      Response.json({ error: 'denied' }, { status }),
    );
    vi.stubGlobal('fetch', fetcher);
    await mount();
    expect(fetcher).not.toHaveBeenCalled();
    await click('Open seller inventory');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(host.querySelector('input')).toBeNull();
    expect(host.textContent).toContain(
      status === 401 ? 'Sign in before' : 'cannot assign roles',
    );
  },
);
it('reviews only the exact price and owned revision, retaining custody disclosure and disabled authority', async () => {
  const data = inventory();
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? Response.json(
          await reviewOperatorListing(data, JSON.parse(init.body as string)),
        )
      : Response.json(data),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Open seller inventory');
  expect(button('Review listing draft').disabled).toBe(true);
  for (const invalid of ['0', '-1', '1.0000000001', '1e2']) {
    await price(invalid);
    expect(button('Review listing draft').disabled).toBe(true);
  }
  await price('0.05');
  await click('Review listing draft');
  expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)).toEqual({
    address: data.wallets[0].address,
    walletRevision: 2,
    priceLamports: '50000000',
  });
  expect(host.textContent).toContain('Unpublished listing review');
  expect(host.textContent).toContain('seller may retain a copy');
  expect(host.textContent).toContain('0.05 SOL');
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(
    [...host.querySelectorAll('button')].some((b) =>
      /^(Publish|Buy|Sign|Approve)/.test(b.textContent ?? ''),
    ),
  ).toBe(false);
  await price('0.06');
  expect(host.textContent).not.toContain('Unpublished listing review');
});
it('aborts a pending review on edits and ignores its late reply', async () => {
  const data = inventory();
  let resolve!: (r: Response) => void;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? new Promise<Response>((r) => (resolve = r))
      : Response.json(data),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Open seller inventory');
  await price('0.05');
  await click('Review listing draft');
  const init = fetcher.mock.calls[1][1]!;
  await price('0.06');
  expect(init.signal!.aborted).toBe(true);
  const review = await reviewOperatorListing(
    data,
    JSON.parse(init.body as string),
  );
  await act(async () => resolve(Response.json(review)));
  expect(host.textContent).not.toContain('Unpublished listing review');
});
it.each(['changed', 'html'])(
  'refuses %s responses without exposing parser text',
  async (kind) => {
    const data = inventory();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (!init?.method) return Response.json(data);
        if (kind === 'html')
          return new Response('<html>private upstream failure</html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          });
        return Response.json({
          ...(await reviewOperatorListing(
            data,
            JSON.parse(init.body as string),
          )),
          signingAllowed: true,
        });
      }),
    );
    await mount();
    await click('Open seller inventory');
    await price('0.05');
    await click('Review listing draft');
    expect(host.textContent).not.toContain('Unpublished listing review');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain('private upstream');
    expect(host.textContent).not.toContain('Zod');
  },
);
it('expires inventory without refreshing automatically', async () => {
  const fetcher = vi.fn(async () => Response.json(inventory()));
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Open seller inventory');
  await act(async () => vi.advanceTimersByTime(60000));
  expect(host.textContent).toContain('Seller inventory expired');
  expect(host.querySelector('input')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
