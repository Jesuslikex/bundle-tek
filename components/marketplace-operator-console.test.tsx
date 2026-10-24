import { savedEvidenceAuthority } from '@/lib/marketplace-saved-evidence';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarketplaceOperatorConsole } from './marketplace-operator-console';
import { marketplaceOwnedFixture } from '../test/marketplace-owned-fixture';
import {
  buildMarketplaceOwnedInventory,
  MarketplaceInventoryCapacityError,
  marketplaceInventoryCapacityBody,
  MARKETPLACE_INVENTORY_CAPACITY_MESSAGE,
} from '@/lib/marketplace-owned-inventory';
import { reviewOperatorListing } from '@/lib/marketplace-operator-review';
import { marketplaceSaleInspectionFixture } from '../test/marketplace-sale-inspection-fixture';
import { marketplaceTokenViewFixture } from '../test/marketplace-token-inspection-view-fixture';
let root: Root, host: HTMLDivElement;
const now = Date.parse('2026-10-20T12:00:00Z');
function inventory() {
  return buildMarketplaceOwnedInventory(
    marketplaceOwnedFixture(now).sources,
    now,
  );
}

it.each(['saved-history-run-limit', 'saved-history-byte-limit'] as const)(
  'explains seller %s without granting review forms or partial inventory',
  async (code) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(inventory()))
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
    await click('Open seller inventory');
    expect(host.querySelector('select')).not.toBeNull();
    await click('Reload seller inventory');
    expect(host.querySelector('select')).toBeNull();
    expect(host.textContent).not.toContain('Asking price (SOL)');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      MARKETPLACE_INVENTORY_CAPACITY_MESSAGE,
    );
    expect(host.textContent).toContain('Inventory is not partially shown');
    expect(host.textContent).toContain('Keep your saved history');
    await act(async () => vi.advanceTimersByTime(120000));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.every(
        ([url, options]) =>
          url === '/api/marketplace/operator/inventory' && !options?.method,
      ),
    ).toBe(true);
  },
);
it.each([
  'wrong-status',
  'extra-field',
  'wrong-code',
  'arbitrary-message',
] as const)('withholds typed seller capacity guidance for %s', async (mode) => {
  const body = marketplaceInventoryCapacityBody(
    new MarketplaceInventoryCapacityError('saved-history-run-limit'),
  );
  const changed =
    mode === 'extra-field'
      ? { ...body, purchaseEnabled: true }
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
  await click('Open seller inventory');
  expect(host.textContent).not.toContain('bounded history pagination');
  expect(host.textContent).not.toContain('private server details');
  expect(host.querySelector('select')).toBeNull();
  expect(host.textContent).not.toContain('Asking price (SOL)');
});
it('ignores stale seller capacity after cancellation and a newer valid inventory read', async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce(Response.json(inventory()));
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Open seller inventory');
  await click('Cancel seller review');
  await click('Open seller inventory');
  await act(async () =>
    resolve(
      Response.json(
        marketplaceInventoryCapacityBody(
          new MarketplaceInventoryCapacityError('saved-history-byte-limit'),
        ),
        { status: 409 },
      ),
    ),
  );
  expect(host.textContent).not.toContain('bounded history pagination');
  expect(host.querySelector('select')).not.toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
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
it('explains an ahead-of-device inventory timestamp without retrying or granting seller forms', async () => {
  const fetcher = vi.fn(async () => Response.json(inventory()));
  vi.stubGlobal('fetch', fetcher);
  vi.setSystemTime(now - 120000);
  await mount();
  await click('Open seller inventory');
  expect(host.textContent).toContain('automatic date and time');
  expect(host.querySelector('select')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
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
    expect(host.querySelector('select')).toBeNull();
    expect(host.textContent).not.toContain('Asking price (SOL)');
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
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
  expect(host.querySelector('select')).toBeNull();
  expect(host.textContent).not.toContain('Asking price (SOL)');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('mounts the manual account check only for a reviewed draft and aborts it when its price changes', async () => {
  const data = inventory(),
    fixture = marketplaceSaleInspectionFixture(now);
  let resolve!: (r: Response) => void;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/account-inspection'))
      return new Promise<Response>((r) => {
        resolve = r;
      });
    return init?.method === 'POST'
      ? Response.json(
          await reviewOperatorListing(data, JSON.parse(init.body as string)),
        )
      : Response.json(data);
  });
  vi.stubGlobal('fetch', fetcher);
  await mount();
  expect(button('Inspect current account')).toBeUndefined();
  await click('Open seller inventory');
  await price('0.05');
  await click('Review listing draft');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(button('Inspect current account')).toBeDefined();
  await click('Inspect current account');
  const init = fetcher.mock.calls[2][1]!;
  expect(JSON.parse(init.body as string)).toEqual(fixture.selection);
  await price('0.06');
  expect(init.signal?.aborted).toBe(true);
  expect(button('Inspect current account')).toBeUndefined();
  await act(async () =>
    resolve(Response.json({ inspection: fixture.inspection })),
  );
  expect(host.textContent).not.toContain('Ordinary SOL account observed');
  expect(host.textContent).not.toContain('Unpublished listing review');
});
it('mounts both checks with distinct identities and aborts a token read when the exact reviewed price changes', async () => {
  const data = inventory(),
    f = await marketplaceTokenViewFixture(now);
  let resolve!: (r: Response) => void;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/token-inspection'))
      return new Promise<Response>((r) => {
        resolve = r;
      });
    return init?.method === 'POST'
      ? Response.json(
          await reviewOperatorListing(data, JSON.parse(init.body as string)),
        )
      : Response.json(data);
  });
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Open seller inventory');
  await price('0.05');
  await click('Review listing draft');
  expect(button('Inspect current account')).toBeDefined();
  expect(button('Inspect owned token accounts')).toBeDefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await click('Inspect owned token accounts');
  const init = fetcher.mock.calls[2][1]!;
  expect(JSON.parse(init.body as string)).toEqual(f.selection);
  await price('0.06');
  expect(init.signal?.aborted).toBe(true);
  expect(button('Inspect current account')).toBeUndefined();
  expect(button('Inspect owned token accounts')).toBeUndefined();
  await act(async () => resolve(Response.json({ inspection: f.inspection })));
  expect(host.textContent).not.toContain('2 owned token accounts returned');
});
it('mounts the saved control check only after review and aborts it on price changes without disturbing other panel identities', async () => {
  const data = inventory();
  let resolve!: (r: Response) => void;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/control-evidence'))
      return new Promise<Response>((r) => {
        resolve = r;
      });
    return init?.method === 'POST'
      ? Response.json(
          await reviewOperatorListing(data, JSON.parse(init.body as string)),
        )
      : Response.json(data);
  });
  vi.stubGlobal('fetch', fetcher);
  await mount();
  expect(button('Check saved control record')).toBeUndefined();
  await click('Open seller inventory');
  await price('0.05');
  await click('Review listing draft');
  expect(button('Check saved control record')).toBeDefined();
  expect(button('Inspect current account')).toBeDefined();
  expect(button('Inspect owned token accounts')).toBeDefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await click('Check saved control record');
  const init = fetcher.mock.calls[2][1]!;
  expect(JSON.parse(init.body as string)).toEqual({
    address: data.wallets[0].address,
    walletRevision: data.wallets[0].revision,
    priceLamports: '50000000',
  });
  await price('0.06');
  expect(init.signal?.aborted).toBe(true);
  expect(button('Check saved control record')).toBeUndefined();
  expect(button('Inspect current account')).toBeUndefined();
  expect(button('Inspect owned token accounts')).toBeUndefined();
  await act(async () => resolve(Response.json({ evidence: {} })));
  expect(host.querySelector('[aria-label="Control record result"]')).toBeNull();
});

it('offers only a passive independent saved-record browser after validated capacity, never a listing selection', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        marketplaceInventoryCapacityBody(
          new MarketplaceInventoryCapacityError('saved-history-run-limit'),
        ),
        { status: 409 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json({
        format: 'marketplace-saved-evidence-page-v1',
        chain: 'Solana',
        view: 'wallets',
        request: { view: 'wallets', cursor: null },
        observedAt: new Date(now).toISOString(),
        nextCursor: null,
        wallets: [],
        ...savedEvidenceAuthority,
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Open seller inventory');
  const browser = [...host.querySelectorAll('details')].find(
    (d) =>
      d.querySelector('summary')?.textContent ===
      'Inspect saved wallet evidence',
  );
  expect(browser).toBeTruthy();
  expect(fetcher).toHaveBeenCalledOnce();
  await act(async () => {
    browser!.open = true;
    browser!.dispatchEvent(new Event('toggle'));
  });
  expect(fetcher).toHaveBeenCalledOnce();
  await click('Load saved wallets');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][0]).toBe(
    '/api/marketplace/saved-evidence?view=wallets',
  );
  expect(host.textContent).not.toContain('Asking price (SOL)');
  expect(
    fetcher.mock.calls.every((c) => (c[1]?.method ?? 'GET') === 'GET'),
  ).toBe(true);
});
it('does not mount saved history from a generic error that copies the capacity message', async () => {
  const fetcher = vi.fn(async () =>
    Response.json(
      { error: MARKETPLACE_INVENTORY_CAPACITY_MESSAGE },
      { status: 503 },
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Open seller inventory');
  expect(
    [...host.querySelectorAll('summary')].some(
      (s) => s.textContent === 'Inspect saved wallet evidence',
    ),
  ).toBe(false);
  expect(fetcher).toHaveBeenCalledOnce();
});
