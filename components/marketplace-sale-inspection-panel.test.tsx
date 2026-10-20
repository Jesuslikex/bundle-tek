// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { marketplaceSaleInspectionFixture } from '../test/marketplace-sale-inspection-fixture';
import { MarketplaceSaleInspectionPanel } from './marketplace-sale-inspection-panel';
const now = Date.parse('2026-10-20T12:00:00.000Z');
let root: Root, host: HTMLDivElement;
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function mount() {
  const f = marketplaceSaleInspectionFixture(now);
  await act(async () =>
    root.render(
      <MarketplaceSaleInspectionPanel
        inventory={f.inventory}
        selection={f.selection}
      />,
    ),
  );
  return f;
}
function button(text: string) {
  return [...host.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )!;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
it('makes no automatic request and displays an exact manual read with incomplete sale status', async () => {
  const f = marketplaceSaleInspectionFixture(now),
    fetcher = vi.fn(async () => Response.json({ inspection: f.inspection }));
  vi.stubGlobal('fetch', fetcher);
  await mount();
  expect(fetcher).not.toHaveBeenCalled();
  await click('Inspect current account');
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = (
    fetcher.mock.calls as unknown as Array<[string, RequestInit]>
  )[0];
  expect(url).toBe('/api/marketplace/operator/account-inspection');
  expect(JSON.parse(init.body as string)).toEqual(f.selection);
  expect(init.cache).toBe('no-store');
  expect(host.textContent).toContain('Ordinary SOL account observed');
  expect(host.textContent).toContain('1 SOL');
  expect(host.textContent).toContain('1.234567891 SOL');
  expect(host.textContent).toContain('−0.234567891 SOL');
  expect(host.textContent).toContain('Sale qualification is incomplete');
  expect(host.textContent).toContain(
    'Payment and key delivery remain unavailable',
  );
  expect(host.querySelector('input')).toBeNull();
  await act(async () => vi.advanceTimersByTime(60000));
  expect(
    host.querySelector('[aria-label="Account inspection result"]'),
  ).toBeNull();
  expect(host.textContent).toContain('expired');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([401, 403, 409, 429, 503])(
  'explains refusal %s without retaining a result or retrying',
  async (status) => {
    const fetcher = vi.fn(async () =>
      Response.json({ error: 'private upstream error' }, { status }),
    );
    vi.stubGlobal('fetch', fetcher);
    await mount();
    await click('Inspect current account');
    expect(host.querySelector('output')).not.toBeNull();
    expect(
      host.querySelector('[aria-label="Account inspection result"]'),
    ).toBeNull();
    expect(host.textContent).not.toContain('private upstream');
    await act(async () => vi.advanceTimersByTime(15000));
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it.each(['html', 'wrong-wallet', 'authority'])(
  'refuses a %s reply without raw parser text',
  async (kind) => {
    const f = marketplaceSaleInspectionFixture(now);
    if (kind === 'wrong-wallet') f.inspection.selection.address = f.fixture.b;
    if (kind === 'authority')
      Object.assign(f.inspection, { deliveryAllowed: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        kind === 'html'
          ? new Response('<html>secret parser text</html>', {
              status: 502,
              headers: { 'content-type': 'text/html' },
            })
          : Response.json({ inspection: f.inspection }),
      ),
    );
    await mount();
    await click('Inspect current account');
    expect(
      host.querySelector('[aria-label="Account inspection result"]'),
    ).toBeNull();
    expect(host.textContent).not.toContain('secret parser');
    expect(host.textContent).not.toContain('Zod');
  },
);
it('cancels a pending read and ignores a late reply', async () => {
  const f = marketplaceSaleInspectionFixture(now);
  let resolve!: (r: Response) => void;
  const fetcher = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Inspect current account');
  const signal = fetcher.mock.calls[0][1]!.signal!;
  await click('Cancel account inspection');
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(Response.json({ inspection: f.inspection })));
  expect(host.textContent).toContain('cancelled');
  expect(
    host.querySelector('[aria-label="Account inspection result"]'),
  ).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('aborts a pending read when the owning review unmounts', async () => {
  const fetcher = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Promise<Response>(() => {}),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Inspect current account');
  const signal = fetcher.mock.calls[0][1]!.signal!;
  await act(async () => root.render(null));
  expect(signal.aborted).toBe(true);
});
