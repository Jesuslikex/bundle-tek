// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WalletWarmupSessionReview } from './wallet-warmup-session-review';
import { warmupSessionReviewFixture } from '../test/warmup-session-review-fixture';
import { WARMUP_RECEIPT_SAVED } from '@/lib/warmup-receipt-events';
let root: Root,
  host: HTMLDivElement,
  fixture: ReturnType<typeof warmupSessionReviewFixture>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture = warmupSessionReviewFixture();
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
  await act(async () =>
    root.render(<WalletWarmupSessionReview plan={fixture.plan} />),
  );
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === text,
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
it('reads only on request, shows the exact budget, and never offers signing or starts a session', async () => {
  const fetcher = vi.fn(async () => Response.json(fixture.response()));
  vi.stubGlobal('fetch', fetcher);
  await mount();
  expect(fetcher).not.toHaveBeenCalled();
  await click('Review automatic session');
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, options] = fetcher.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(url).toContain('/session-review');
  expect(JSON.parse(options.body as string)).toEqual({
    id: fixture.plan.id,
    revision: 1,
  });
  expect(host.textContent).toContain('0.012 SOL');
  expect(host.textContent).toContain('4 remaining actions across 1 wallet');
  expect(host.textContent).toContain('Automatic execution is disabled');
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  expect(
    [...host.querySelectorAll('button')].some((button) =>
      /^(Start|Sign|Submit)/.test(button.textContent ?? ''),
    ),
  ).toBe(false);
});
it('expires a review without an automatic reload', async () => {
  const fetcher = vi.fn(async () => Response.json(fixture.response()));
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Review automatic session');
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(host.textContent).toContain('review expired');
  expect(host.textContent).not.toContain('Maximum further spend:');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('cancels and ignores a late response', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Review automatic session');
  await click('Cancel session review');
  await act(async () => finish(Response.json(fixture.response())));
  expect(host.textContent).toContain('review cancelled');
  expect(host.textContent).not.toContain('Maximum further spend:');
});

it('discards a pending response when the saved plan context changes', async () => {
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
  await click('Review automatic session');
  await act(async () =>
    root.render(
      <WalletWarmupSessionReview plan={{ ...fixture.plan, revision: 2 }} />,
    ),
  );
  await act(async () => finish(Response.json(fixture.response())));
  expect(host.textContent).not.toContain('Maximum further spend:');
  expect(host.querySelector('[aria-busy="true"]')).toBeNull();
});
it('shows a useful timeout error and enables a manual retry', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockRejectedValue(
        new DOMException('The operation was aborted', 'TimeoutError'),
      ),
  );
  await mount();
  await click('Review automatic session');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'took too long',
  );
  expect(
    [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Review automatic session',
    )!.disabled,
  ).toBe(false);
});
it.each(['receipt', 'storage', 'pagehide', 'plan'] as const)(
  'invalidates an open review on %s without another read',
  async (kind) => {
    const fetcher = vi.fn(async () => Response.json(fixture.response()));
    vi.stubGlobal('fetch', fetcher);
    await mount();
    await click('Review automatic session');
    await act(async () => {
      if (kind === 'receipt')
        window.dispatchEvent(
          new CustomEvent(WARMUP_RECEIPT_SAVED, {
            detail: { planId: fixture.plan.id },
          }),
        );
      else if (kind === 'plan')
        root.render(
          <WalletWarmupSessionReview plan={{ ...fixture.plan, revision: 2 }} />,
        );
      else window.dispatchEvent(new Event(kind));
    });
    expect(host.textContent).not.toContain('Maximum further spend:');
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it('shows a controlled error for an HTML page and allows a manual retry', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('<html>bad gateway</html>', { status: 502 }),
    )
    .mockImplementation(async () => Response.json(fixture.response()));
  vi.stubGlobal('fetch', fetcher);
  await mount();
  await click('Review automatic session');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Session review unavailable',
  );
  expect(host.textContent).not.toMatch(/Unexpected token|<html>/);
  await click('Review automatic session');
  expect(host.textContent).toContain('Maximum further spend:');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('paginates large finite action lists instead of rendering every row', async () => {
  fixture = warmupSessionReviewFixture(Date.now(), 13);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(fixture.response())),
  );
  await mount();
  await click('Review automatic session');
  const summary = [...host.querySelectorAll('summary')].find(
    (element) => element.textContent === 'Review remaining actions',
  )!;
  await act(async () => summary.click());
  expect(host.querySelectorAll('ol li')).toHaveLength(20);
  await click('Next actions');
  expect(host.querySelector('ol')?.start).toBe(21);
  expect(host.querySelectorAll('ol li')).toHaveLength(6);
  expect(host.textContent).toContain('Actions 21 to 26 of 26');
});
