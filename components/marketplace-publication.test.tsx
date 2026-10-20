// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { marketplacePublicationFixture } from '../test/marketplace-publication-fixture';
import { MarketplacePublication } from './marketplace-publication';
import {
  PUBLICATION_ACK,
  WITHDRAWAL_ACK,
  type PublicationRecord,
} from '@/lib/marketplace-publication';
let root: Root,
  host: HTMLDivElement,
  f: Awaited<ReturnType<typeof marketplacePublicationFixture>>;
const now = Date.parse('2026-10-20T12:00:00Z');
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
  f = await marketplacePublicationFixture(now);
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
async function mount() {
  await act(async () =>
    root.render(<MarketplacePublication draft={f.draft} />),
  );
}
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
async function click(text: string) {
  await act(async () => button(text).click());
}
async function check(text: string) {
  const label = [...host.querySelectorAll('label')].find(
    (l) => l.textContent === text,
  )!;
  await act(async () =>
    (label.querySelector('input') as HTMLInputElement).click(),
  );
}
function server() {
  let record: PublicationRecord | null = null;
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init?.method) return Response.json({ publication: record });
    const body = JSON.parse(init.body as string);
    if (body.action === 'review') return Response.json({ preview: f.preview });
    if (body.action === 'publish') record = { ...f.record, id: body.id };
    else record = { ...record!, withdrawnAt: new Date(now).toISOString() };
    return Response.json({ publication: record });
  });
}
it('requires a fresh unchecked publication approval, displays public evidence and separately approves withdrawal', async () => {
  const fetcher = server();
  vi.stubGlobal('fetch', fetcher);
  await mount();
  expect(fetcher).not.toHaveBeenCalled();
  await click('Review catalog publication');
  expect(button('Publish catalog listing').disabled).toBe(true);
  expect(host.textContent).toContain('Historical balance');
  expect(host.textContent).toContain('Unique recorded warmup signatures');
  await check(PUBLICATION_ACK);
  await click('Publish catalog listing');
  expect(host.textContent).toContain('Publication recorded');
  expect(button('Withdraw catalog listing').disabled).toBe(true);
  expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)).toMatchObject({
    action: 'publish',
    draftId: f.draft.id,
    contextSha256: f.preview.contextSha256,
    acknowledgement: PUBLICATION_ACK,
  });
  await check(WITHDRAWAL_ACK);
  await click('Withdraw catalog listing');
  expect(host.textContent).toContain('Listing withdrawn');
  expect(
    fetcher.mock.calls.filter((c) => c[1]?.method === 'POST'),
  ).toHaveLength(3);
  expect(host.querySelector('input[type="password"]')).toBeNull();
});
it('recovers an uncertain publication with one publish write and no automatic retry after remount', async () => {
  const normal = server();
  let written: PublicationRecord | null = null;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : null;
    if (body?.action === 'publish') {
      written = { ...f.record, id: body.id };
      throw Error('lost');
    }
    if (!init?.method) return Response.json({ publication: written });
    return normal(url, init);
  });
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Review catalog publication');
  await check(PUBLICATION_ACK);
  await click('Publish catalog listing');
  expect(host.textContent).toContain('outcome is unknown');
  expect(button('Clear publication reminder').disabled).toBe(true);
  await act(async () => root.unmount());
  root = createRoot(host);
  await mount();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await click('Recover publication');
  expect(host.textContent).toContain('Recovered: publication recorded');
  expect(
    fetcher.mock.calls.filter(
      (c) => c[1]?.body && JSON.parse(c[1].body as string).action === 'publish',
    ),
  ).toHaveLength(1);
});
it('does not publish after preview expiry or carry approval into a refreshed preview', async () => {
  vi.stubGlobal('fetch', server());
  await mount();
  await click('Review catalog publication');
  await check(PUBLICATION_ACK);
  await act(async () => vi.advanceTimersByTime(60000));
  expect(host.textContent).toContain('Publication review expired');
  expect(button('Publish catalog listing')).toBeUndefined();
});
it.each(['price', 'authority', 'html'] as const)(
  'refuses an altered %s preview without publishing',
  async (kind) => {
    const preview = structuredClone(f.preview);
    if (kind === 'price') preview.listing.priceLamports = '1';
    if (kind === 'authority') Object.assign(preview, { purchaseEnabled: true });
    const fetcher = vi.fn(async () =>
      kind === 'html'
        ? new Response('<html>private failure</html>', { status: 502 })
        : Response.json({ preview }),
    );
    vi.stubGlobal('fetch', fetcher);
    await mount();
    await click('Review catalog publication');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(button('Publish catalog listing')).toBeUndefined();
    expect(host.textContent).not.toContain('private failure');
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it('blocks publication if its recovery ID cannot be retained locally', async () => {
  const fetcher = server();
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Review catalog publication');
  await check(PUBLICATION_ACK);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('blocked');
  });
  await click('Publish catalog listing');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('Nothing was sent');
});
it('explains why a watch-only draft cannot be published without trying to sign or publish', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({ error: 'Verify control' }, { status: 422 }),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Review catalog publication');
  expect(host.textContent).toContain('Verify control of this wallet');
  expect(button('Publish catalog listing')).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('finds a previous publication by the owned saved draft without a local reminder', async () => {
  const fetcher = vi.fn(async (_url: string) =>
    Response.json({ publication: f.record }),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Check existing publication');
  expect(fetcher.mock.calls[0][0]).toBe(
    '/api/marketplace/operator/publications?draftId=' + f.draft.id,
  );
  expect(host.textContent).toContain('Recovered: publication recorded');
  expect(host.querySelector('input[type="checkbox"]')).not.toBeNull();
});
it('recovers a committed withdrawal after response loss without a second withdrawal', async () => {
  const normal = server(),
    fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const response = await normal(url, init);
      if (init?.body && JSON.parse(init.body as string).action === 'withdraw')
        throw Error('lost');
      return response;
    });
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Review catalog publication');
  await check(PUBLICATION_ACK);
  await click('Publish catalog listing');
  await check(WITHDRAWAL_ACK);
  await click('Withdraw catalog listing');
  expect(host.textContent).toContain('outcome is unknown');
  await click('Recover publication');
  expect(host.textContent).toContain('Recovered: listing withdrawn');
  expect(
    fetcher.mock.calls.filter(
      (c) =>
        c[1]?.body && JSON.parse(c[1].body as string).action === 'withdraw',
    ),
  ).toHaveLength(1);
});
it('stops waiting, preserves the ID and ignores a late publication response', async () => {
  let finish!: (r: Response) => void;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    if (body.action === 'review') return Response.json({ preview: f.preview });
    return new Promise<Response>((r) => (finish = r));
  });
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Review catalog publication');
  await check(PUBLICATION_ACK);
  await click('Publish catalog listing');
  const request = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
  await click('Stop publication wait');
  expect(fetcher.mock.calls[1][1]!.signal!.aborted).toBe(true);
  await act(async () =>
    finish(Response.json({ publication: { ...f.record, id: request.id } })),
  );
  expect(host.textContent).not.toContain('Publication recorded');
  expect(sessionStorage.getItem(`bundle:publication:${f.draft.id}`)).toContain(
    request.id,
  );
});
