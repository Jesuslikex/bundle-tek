// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ImportedPairOrderReview } from './imported-pair-order-review';
import {
  pairReviewUiFixture,
  pairReviewUiRequest,
} from '../test/pair-order-first-ui-fixture';
import { pairRuntimeDigest } from '@/lib/pair-runtime-trace';
const now = Date.UTC(2026, 9, 16);
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(now);
  vi.stubGlobal('crypto', {
    subtle: {
      digest: async (_algorithm: string, bytes: Uint8Array) =>
        Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer,
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const button = (text: string) =>
  Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === text,
  )!;
const checks = () =>
  Array.from(
    container.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
  );
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function mount(warning = false, marketWarning = false) {
  const saved = await pairReviewUiFixture(now, warning, marketWarning);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(saved))
    .mockResolvedValueOnce(
      Response.json({ error: 'Stock signing is disabled.' }, { status: 409 }),
    );
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(<ImportedPairOrderReview request={pairReviewUiRequest} />),
  );
  await click(button('Prepare order review'));
  return { saved, fetcher };
}
it('renders exact amounts, decoded route, impact, fees, expiry and missing market reason with unchecked consent', async () => {
  await mount();
  expect(container.textContent).toContain('0.995 TEST');
  expect(container.textContent).toContain('Raydium');
  expect(container.textContent).toContain('0.12%');
  expect(container.textContent).toContain('2039280');
  expect(container.textContent).toContain('No fresh server USD observation');
  expect(container.textContent).toContain('Initial Jupiter preview');
  expect(container.textContent).toContain(
    '995995 atomic units. Order minimum: 995000 atomic units. Fresh-reference tolerance: 0.1%',
  );
  expect(checks()).toHaveLength(2);
  expect(checks()[0].checked).toBe(false);
  expect(button('Request signing authorization').disabled).toBe(true);
});
it.each([
  [true, false],
  [false, true],
])('requires both separate consents for warning %s/%s', async (a, b) => {
  const { saved, fetcher } = await mount(a, b);
  expect(checks()).toHaveLength(a && !b ? 3 : 2);
  expect(checks().every((x) => !x.checked)).toBe(true);
  await click(checks()[0]);
  expect(button('Request signing authorization').disabled).toBe(true);
  for (const box of checks().slice(1)) await click(box);
  expect(button('Request signing authorization').disabled).toBe(false);
  await click(button('Request signing authorization'));
  expect(fetcher).toHaveBeenCalledTimes(2);
  const payload = JSON.parse(fetcher.mock.calls[1][1].body);
  expect(payload).toMatchObject({
    action: 'approve',
    id: saved.id,
    consent: {
      reviewSha256: saved.review.sha256,
      approvedMinimumOutputRaw: '995000',
      acknowledgeIndependentDifference: true,
    },
  });
  expect(container.querySelector('[role=alert]')?.textContent).toBe(
    'Stock signing is disabled.',
  );
  expect(button('Request signing authorization').disabled).toBe(true);
  expect(checks().every((x) => !x.checked)).toBe(true);
});
it('expires and clears displayed consent using a controlled clock, with no automatic authorization', async () => {
  const { fetcher } = await mount();
  await click(checks()[0]);
  await act(async () => vi.advanceTimersByTime(30000));
  expect(checks()[0].checked).toBe(false);
  expect(button('Request signing authorization').disabled).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(['wallet', 'market'] as const)(
  'invalidates review and consent synchronously when %s changes',
  async (mode) => {
    const { fetcher } = await mount();
    await click(checks()[0]);
    await act(async () =>
      root.render(
        <ImportedPairOrderReview
          request={
            mode === 'wallet'
              ? { ...pairReviewUiRequest, walletRevision: 2 }
              : {
                  ...pairReviewUiRequest,
                  marketPair: pairReviewUiRequest.quoteMint,
                }
          }
        />,
      ),
    );
    expect(checks()).toHaveLength(0);
    expect(button('Request signing authorization')).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it('aborts an old request and refuses its result after a selection change', async () => {
  const saved = await pairReviewUiFixture(now);
  let release: (value: Response) => void = () => {};
  const fetcher = vi.fn(
    (_input: unknown, _options: RequestInit) =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(<ImportedPairOrderReview request={pairReviewUiRequest} />),
  );
  await click(button('Prepare order review'));
  const signal = fetcher.mock.calls[0][1].signal!;
  await act(async () =>
    root.render(
      <ImportedPairOrderReview
        request={{ ...pairReviewUiRequest, side: 'Sell' }}
      />,
    ),
  );
  expect(signal.aborted).toBe(true);
  await act(async () => release(Response.json(saved)));
  expect(checks()).toHaveLength(0);
});
it('shows friendly HTML errors, without retries', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response('<html>Bad gateway</html>', { status: 502 }),
    );
  vi.stubGlobal('fetch', fetcher);
  await act(async () =>
    root.render(<ImportedPairOrderReview request={pairReviewUiRequest} />),
  );
  await click(button('Prepare order review'));
  expect(container.querySelector('[role=alert]')?.textContent).toBe(
    'Order review service unavailable. Request a new review.',
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('blocks authorization when price impact is unavailable', async () => {
  const saved = await pairReviewUiFixture(now);
  saved.review.priceImpactPct = null;
  const { sha256: _old, ...terms } = saved.review;
  saved.review.sha256 = await pairRuntimeDigest(terms);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(saved)));
  await act(async () =>
    root.render(<ImportedPairOrderReview request={pairReviewUiRequest} />),
  );
  await click(button('Prepare order review'));
  await click(checks()[0]);
  expect(button('Request signing authorization').disabled).toBe(true);
  expect(container.textContent).toContain('Price impact is unavailable');
});

it('requires the unavailable-price checkbox separately, sends its exact consent and resets after the attempt', async () => {
  const { fetcher } = await mount();
  expect(container.textContent).toContain(
    'No independent price check is available for this order.',
  );
  expect(checks()[1].checked).toBe(false);
  await click(checks()[0]);
  expect(button('Request signing authorization').disabled).toBe(true);
  await click(checks()[1]);
  expect(button('Request signing authorization').disabled).toBe(false);
  await click(button('Request signing authorization'));
  const payload = JSON.parse(fetcher.mock.calls[1][1].body);
  expect(payload.consent.acknowledgeUnavailableIndependentPrice).toBe(true);
  expect(payload.consent.acknowledgeIndependentDifference).toBe(false);
  expect(checks().every((box) => !box.checked)).toBe(true);
});
