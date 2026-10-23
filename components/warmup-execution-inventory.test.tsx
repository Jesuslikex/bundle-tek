// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { WarmupExecutionInventory } from './warmup-execution-inventory';
import { WalletWarmup } from './wallet-warmup';
import { warmupUiFixture } from '@/test/warmup-ui-fixture';
import { warmupExecutionInventoryUiFixture as fixture } from '@/test/warmup-execution-inventory-ui-fixture';
let host: HTMLDivElement, root: Root;
const endpoint = '/api/wallet-workspace/warmup/execution-history';
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function mount() {
  await act(async () => root.render(<WarmupExecutionInventory />));
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(
    (e) => e.textContent === text,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
it('reads explicitly, reports expired lifetime capacity and never offers execution', async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json(fixture().first),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  expect(fetcher).not.toHaveBeenCalled();
  await click('Read stored warmup reviews and capacity');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe(endpoint);
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    method: 'GET',
    cache: 'no-store',
  });
  expect(fetcher.mock.calls[0][1]?.body).toBeUndefined();
  expect(host.textContent).toContain('Account-wide metadata');
  expect(host.textContent).toContain('1 of 128; 127 remaining');
  expect(host.textContent).toContain('100 bytes of 268,435,456 bytes');
  expect(host.textContent).toContain('Incomplete stored proposal');
  expect(host.textContent).toContain('Expired at this snapshot; still counted');
  expect(host.textContent).toContain('No pruning is available');
  expect(host.textContent).toContain(
    'Signing and automatic execution remain off',
  );
  expect(
    [...host.querySelectorAll('button')].some((e) =>
      /^(Start|Approve|Sign|Submit)/.test(e.textContent ?? ''),
    ),
  ).toBe(false);
});
it('replaces older metadata pages with their own snapshot and can explicitly return to newest', async () => {
  const f = fixture(26),
    fetcher = vi.fn(async (url: string) =>
      Response.json(url.includes('?cursor=') ? f.older : f.first),
    );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Read stored warmup reviews and capacity');
  expect(
    host.querySelectorAll('ul[aria-label="Stored warmup metadata page"] > li'),
  ).toHaveLength(25);
  await click('Read older stored metadata');
  expect(
    host.querySelectorAll('ul[aria-label="Stored warmup metadata page"] > li'),
  ).toHaveLength(1);
  expect(host.textContent).toContain('Page 2');
  expect(host.textContent).toContain('26 of 128');
  expect(fetcher.mock.calls[1][0]).toBe(
    endpoint + '?cursor=' + encodeURIComponent(f.first.nextCursor!),
  );
  await click('Read newest stored metadata');
  expect(host.textContent).toContain('Page 1');
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it('clears metadata on close and ignores an uncooperative deferred response after reopening', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(
    (_url: string, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Read stored warmup reviews and capacity');
  const late = finish,
    firstSignal = fetcher.mock.calls[0][1]?.signal;
  await click('Close stored warmup metadata');
  expect(firstSignal?.aborted).toBe(true);
  expect(host.textContent).not.toContain('Lifetime metadata capacity');
  await click('Read stored warmup reviews and capacity');
  await act(async () => late(Response.json(fixture(26).first)));
  expect(host.textContent).not.toContain('26 of 128');
  await act(async () => finish(Response.json(fixture().first)));
  expect(host.textContent).toContain('1 of 128');
});
it('cancels and clears before late completion, then permits a fresh explicit read', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(
    (_url: string, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Read stored warmup reviews and capacity');
  const late = finish;
  await click('Cancel metadata read');
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await act(async () => late(Response.json(fixture().first)));
  expect(host.textContent).not.toContain('Lifetime metadata capacity');
  await click('Read newest stored metadata');
  await act(async () => finish(Response.json(fixture().first)));
  await click('Clear metadata view');
  expect(host.textContent).not.toContain('Lifetime metadata capacity');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('ends a timed-out metadata read even if fetch does not cooperate, and cancels on unmount', async () => {
  vi.useFakeTimers();
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(
    (_url: string, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Read stored warmup reviews and capacity');
  await act(async () => vi.advanceTimersByTime(23000));
  expect(host.textContent).toContain('ended before confirmation');
  expect(host.textContent).not.toContain('Reading stored warmup metadata');
  await act(async () => finish(Response.json(fixture().first)));
  expect(host.textContent).not.toContain('Lifetime metadata capacity');
  await click('Read newest stored metadata');
  const signal = fetcher.mock.calls[1][1]?.signal;
  await act(async () => root.render(null));
  expect(signal?.aborted).toBe(true);
});
it.each(['html', 'invalid', 'unauthorized', 'unavailable'] as const)(
  'shows safe %s failures without parser or server text',
  async (kind) => {
    const page = fixture().first;
    Object.assign(page, { signingAllowed: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        kind === 'html'
          ? new Response('<html>private-parser-marker</html>', { status: 502 })
          : kind === 'invalid'
            ? Response.json(page)
            : Response.json(
                { error: 'private-parser-marker' },
                { status: kind === 'unauthorized' ? 401 : 503 },
              ),
      ),
    );
    await mount();
    await click('Read stored warmup reviews and capacity');
    expect(host.querySelector('[role="alert"]')?.textContent).not.toBe('');
    expect(host.textContent).not.toContain('private-parser-marker');
    expect(host.textContent).not.toContain('Lifetime metadata capacity');
    if (kind === 'unauthorized')
      expect(host.querySelector('a[href="/sign-in"]')).not.toBeNull();
  },
);
it('mounts in the actual warmup dialog without an inventory request until the explicit read', async () => {
  const f = warmupUiFixture();
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    url.startsWith(endpoint)
      ? Response.json(fixture(0).first)
      : f.fetcher(url, init),
  );
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(
      <WalletWarmup
        chain="Solana"
        addresses={[f.wallet]}
        walletRevisions={[{ address: f.wallet, revision: 1 }]}
        onClose={() => {}}
      />,
    ),
  );
  expect(fetcher.mock.calls.some(([url]) => url.startsWith(endpoint))).toBe(
    false,
  );
  const panel = [...host.querySelectorAll('h4')]
    .find((e) => e.textContent === 'Stored warmup reviews and capacity')!
    .closest('section')!;
  expect(panel.closest('form')).toBeNull();
  await click('Read stored warmup reviews and capacity');
  expect(
    fetcher.mock.calls.filter(([url]) => url.startsWith(endpoint)),
  ).toHaveLength(1);
  expect(host.textContent).toContain(
    'No stored execution proposals in this account',
  );
  expect(
    fetcher.mock.calls
      .filter(([url]) => url.startsWith(endpoint))
      .every(([, init]) => init?.method === 'GET'),
  ).toBe(true);
});

it('keeps stable announcements and focus across page reads, refresh, errors, clear and close', async () => {
  const f = fixture(26);
  let fail = false;
  const fetcher = vi.fn(async (url: string) =>
    fail
      ? new Response('<html>private-error</html>', { status: 503 })
      : Response.json(url.includes('?cursor=') ? f.older : f.first),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Read stored warmup reviews and capacity');
  const heading = host.querySelector('h5[tabindex="-1"]')!;
  const status = host.querySelector('output[aria-live="polite"]')!,
    alert = host.querySelector('[role="alert"]')!;
  expect(document.activeElement).toBe(heading);
  expect(status.textContent).toContain('page 1 loaded');
  expect(alert.textContent).toBe('');
  const older = [...host.querySelectorAll('button')].find(
    (e) => e.textContent === 'Read older stored metadata',
  )!;
  older.focus();
  await click('Read older stored metadata');
  expect(document.activeElement).toBe(heading);
  expect(host.querySelector('output')).toBe(status);
  expect(host.querySelector('[role="alert"]')).toBe(alert);
  expect(status.textContent).toContain('page 2 loaded');
  fail = true;
  await click('Read newest stored metadata');
  expect(document.activeElement).toBe(heading);
  expect(alert.textContent).toContain('unavailable');
  await click('Clear metadata view');
  expect(alert.textContent).toBe('');
  expect(status.textContent).toContain('view cleared');
  await click('Close stored warmup metadata');
  const opener = [...host.querySelectorAll('button')].find(
    (e) => e.textContent === 'Read stored warmup reviews and capacity',
  );
  expect(document.activeElement).toBe(opener);
});
it('does not steal focus from another warmup control after a slow metadata read', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  await mount();
  await click('Read stored warmup reviews and capacity');
  const otherControl = document.createElement('input');
  otherControl.setAttribute('aria-label', 'Another warmup setting');
  host.appendChild(otherControl);
  otherControl.focus();
  try {
    await act(async () => finish(Response.json(fixture().first)));
    expect(host.textContent).toContain('1 of 128');
    expect(document.activeElement).toBe(otherControl);
  } finally {
    otherControl.remove();
  }
});
it('handles an HTML 401 by status and exposes sign-in without parsing the page', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('<html>private-auth-proxy</html>', { status: 401 }),
    ),
  );
  await mount();
  await click('Read stored warmup reviews and capacity');
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    'Sign in to read stored warmup metadata.',
  );
  expect(host.querySelector('a[href="/sign-in"]')).not.toBeNull();
  expect(host.textContent).not.toContain('private-auth-proxy');
});
it.each([262144, 262145])(
  'bounds successful JSON responses at actual %i UTF-8 bytes',
  async (size) => {
    const value = JSON.stringify(fixture(0).first).padEnd(size, ' ');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(value, {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await mount();
    await click('Read stored warmup reviews and capacity');
    expect(host.textContent?.includes('Lifetime metadata capacity')).toBe(
      size === 262144,
    );
    expect(host.querySelector('[role="alert"]')?.textContent === '').toBe(
      size === 262144,
    );
  },
);
it('counts UTF-8 bytes rather than characters and cancels a pending response stream', async () => {
  const oversized = JSON.stringify(fixture(0).first) + '\u4e00'.repeat(90000);
  const fetcher = vi.fn(async () => new Response(oversized));
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Read stored warmup reviews and capacity');
  expect(host.textContent).not.toContain('Lifetime metadata capacity');
  let cancelled = false;
  fetcher.mockImplementation(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{'));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  // The read stays open until the explicit cancel; it is not a new provider call.
  await click('Read newest stored metadata');
  await click('Cancel metadata read');
  expect(cancelled).toBe(true);
  expect(host.textContent).not.toContain('Lifetime metadata capacity');
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('');
});
