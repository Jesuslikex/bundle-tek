// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createHash } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { marketplaceTokenViewFixture } from '../test/marketplace-token-inspection-view-fixture';
import { MarketplaceTokenInspectionPanel } from './marketplace-token-inspection-panel';
const now = Date.parse('2026-10-20T12:00:00.000Z');
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', {
    subtle: {
      digest: async (_algorithm: string, bytes: Uint8Array) =>
        Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer,
    },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function mount(f = marketplaceTokenViewFixture(now)) {
  const value = await f;
  await act(async () =>
    root.render(
      <MarketplaceTokenInspectionPanel
        inventory={value.inventory}
        selection={value.selection}
      />,
    ),
  );
  return value;
}
function button(text: string) {
  return [...host.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )!;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
it('makes an exact manual request and shows raw units, authorities and separate incomplete coverage without any financial action', async () => {
  const f = await marketplaceTokenViewFixture(now),
    fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ inspection: f.inspection }),
    );
  vi.stubGlobal('fetch', fetcher);
  await mount(Promise.resolve(f));
  expect(fetcher).not.toHaveBeenCalled();
  await click('Inspect owned token accounts');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe(
    '/api/marketplace/operator/token-inspection',
  );
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual(
    f.selection,
  );
  expect(host.textContent).toContain('2 owned token accounts returned');
  expect(host.textContent).toContain('18446744073709551615');
  expect(host.textContent).toContain('raw base units');
  expect(host.textContent).toContain('Delegate present');
  expect(host.textContent).toContain('External close authority');
  expect(host.textContent).toContain('Extension semantics need review');
  expect(host.textContent).toContain('not proof of an empty wallet');
  expect(host.querySelector('input')).toBeNull();
  expect(button('Inspect owned tokens again').disabled).toBe(true);
  expect(
    [...host.querySelectorAll('button')].some((b) =>
      /^(Buy|Sign|Pay|Transfer|Approve)/.test(b.textContent ?? ''),
    ),
  ).toBe(false);
});
it('pages every returned account locally and preserves exact snapshot identity without more network requests', async () => {
  const f = await marketplaceTokenViewFixture(now, 25),
    fetcher = vi.fn(async () => Response.json({ inspection: f.inspection }));
  vi.stubGlobal('fetch', fetcher);
  await mount(Promise.resolve(f));
  await click('Inspect owned token accounts');
  expect(host.querySelectorAll('ul > li')).toHaveLength(20);
  expect(host.textContent).toContain('Accounts 1–20 of 25');
  await click('Next token accounts');
  expect(host.querySelectorAll('ul > li')).toHaveLength(5);
  expect(host.textContent).toContain('Accounts 21–25 of 25');
  expect(button('Next token accounts').disabled).toBe(true);
  expect(document.activeElement).toBe(host.querySelector('h3'));
  await act(async () => {
    button('Previous token accounts').click();
    button('Previous token accounts').click();
  });
  expect(host.querySelectorAll('ul > li')).toHaveLength(20);
  expect(button('Previous token accounts').disabled).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('shows zero returned accounts without approving an empty or sale-ready wallet', async () => {
  const f = await marketplaceTokenViewFixture(now, 0);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ inspection: f.inspection })),
  );
  await mount(Promise.resolve(f));
  await click('Inspect owned token accounts');
  expect(host.textContent).toContain('0 owned token accounts returned');
  expect(host.textContent).toContain('not proof of an empty wallet');
  expect(host.textContent).toContain('full asset coverage remain unverified');
  expect(host.querySelector('ul')).toBeNull();
});
it.each(['authority', 'count', 'hash', 'price', 'html'])(
  'refuses %s responses without retaining an apparent complete result or raw parser text',
  async (change) => {
    const f = await marketplaceTokenViewFixture(now),
      payload = structuredClone(f.inspection);
    if (change === 'authority')
      Object.assign(payload, { signingAllowed: true });
    if (change === 'count') payload.accountCount++;
    if (change === 'hash') payload.sellerEvidenceSha256 = 'b'.repeat(64);
    if (change === 'price') payload.selection.priceLamports = '1';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        change === 'html'
          ? new Response('<html>private backend detail</html>', {
              status: 502,
              headers: { 'content-type': 'text/html' },
            })
          : Response.json({ inspection: payload }),
      ),
    );
    await mount(Promise.resolve(f));
    await click('Inspect owned token accounts');
    expect(
      host.querySelector('[aria-label="Owned token inspection result"]'),
    ).toBeNull();
    expect(host.querySelector('output')).not.toBeNull();
    expect(host.textContent).not.toContain('private backend');
    expect(host.textContent).not.toContain('Zod');
  },
);
it.each([400, 401, 403, 408, 409, 413, 415, 429, 503])(
  'explains refusal %s without exposing remote text or retrying',
  async (status) => {
    const fetcher = vi.fn(async () =>
      Response.json({ error: 'private SQL or provider error' }, { status }),
    );
    vi.stubGlobal('fetch', fetcher);
    await mount();
    await click('Inspect owned token accounts');
    expect(host.querySelector('output')).not.toBeNull();
    expect(
      host.querySelector('[aria-label="Owned token inspection result"]'),
    ).toBeNull();
    expect(host.textContent).not.toContain('private SQL');
    await act(async () => vi.advanceTimersByTime(15000));
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it('cancels and ignores a late response while keeping the full manual cooldown', async () => {
  const f = await marketplaceTokenViewFixture(now);
  let resolve!: (r: Response) => void;
  const fetcher = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount(Promise.resolve(f));
  await click('Inspect owned token accounts');
  const signal = fetcher.mock.calls[0][1]!.signal!;
  await click('Cancel token inspection');
  expect(signal.aborted).toBe(true);
  expect(button('Inspect owned token accounts').disabled).toBe(true);
  await act(async () => resolve(Response.json({ inspection: f.inspection })));
  expect(
    host.querySelector('[aria-label="Owned token inspection result"]'),
  ).toBeNull();
  await act(async () => vi.advanceTimersByTime(15000));
  expect(button('Inspect owned token accounts').disabled).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('aborts its pending read when the owning review unmounts', async () => {
  const fetcher = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Promise<Response>(() => {}),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Inspect owned token accounts');
  const signal = fetcher.mock.calls[0][1]!.signal!;
  await act(async () => root.render(null));
  expect(signal.aborted).toBe(true);
});
it('expires the inspection and clears paged rows without polling', async () => {
  const f = await marketplaceTokenViewFixture(now, 25),
    fetcher = vi.fn(async () => Response.json({ inspection: f.inspection }));
  vi.stubGlobal('fetch', fetcher);
  await mount(Promise.resolve(f));
  await click('Inspect owned token accounts');
  await click('Next token accounts');
  await act(async () => vi.advanceTimersByTime(60000));
  expect(
    host.querySelector('[aria-label="Owned token inspection result"]'),
  ).toBeNull();
  expect(host.textContent).toContain('expired');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejects a future inspection with clock guidance, retaining all freshness checks', async () => {
  const f = await marketplaceTokenViewFixture(now),
    payload = structuredClone(f.inspection);
  payload.startedAt = new Date(now + 120000).toISOString();
  payload.observedAt = payload.startedAt;
  payload.expiresAt = new Date(now + 180000).toISOString();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ inspection: payload })),
  );
  await mount(Promise.resolve(f));
  await click('Inspect owned token accounts');
  expect(host.textContent).toContain('automatic date and time');
  expect(
    host.querySelector('[aria-label="Owned token inspection result"]'),
  ).toBeNull();
});
