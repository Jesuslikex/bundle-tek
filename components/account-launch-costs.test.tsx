// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountLaunchCosts } from './account-launch-costs';
import {
  recordedCostResponse,
  recordedCostReviewId,
  recordedCostMint,
} from '@/test/pump-group-recorded-costs-fixture';
let host: HTMLDivElement, root: Root;
const fetchMock = vi.fn<typeof fetch>();
const mount = async (reviewId = recordedCostReviewId) => {
  await act(async () =>
    root.render(
      <AccountLaunchCosts reviewId={reviewId} mint={recordedCostMint} />,
    ),
  );
};
const click = async (text: string) => {
  const button = [...host.querySelectorAll('button')].find(
    (el) => el.textContent === text,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('starts collapsed without fetching and shows exact separate costs only on explicit review', async () => {
  await mount();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(host.querySelector('details')?.open).toBe(false);
  await act(async () => host.querySelector('summary')!.click());
  fetchMock.mockResolvedValueOnce(Response.json(recordedCostResponse));
  await click('Review recorded costs');
  expect(host.textContent).toContain('0.000016 SOL');
  expect(host.textContent).toContain('Jito tip paid');
  expect(host.textContent).toContain('0.000001 SOL');
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/account-launch-activity/costs?reviewId=' + recordedCostReviewId,
    expect.objectContaining({
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    }),
  );
});
it('shows unknown amounts and partial subtotals without inventing zero-cost coverage', async () => {
  fetchMock.mockResolvedValueOnce(
    Response.json({
      ...recordedCostResponse,
      outcome: 'expired-unobserved',
      packets: [{ index: 0, outcome: 'unobserved', networkFeeLamports: null }],
      groupNetworkFeeLamports: '0',
      tipNetworkFeeLamports: null,
      tipLamports: null,
      knownTotalLamports: '0',
      feeAndTipCoverageComplete: false,
    }),
  );
  await mount();
  await click('Review recorded costs');
  expect(host.textContent).toContain('Recorded cost total is unavailable.');
  expect(host.querySelector('strong')).toBeNull();
  expect(host.querySelector('dl')?.textContent).toContain(
    'Launch packet feesUnknown',
  );
  expect(host.querySelector('dl')?.textContent).toContain(
    'Tip transaction feeUnknown',
  );
  expect(host.querySelector('dl')?.textContent).toContain(
    'Jito tip paidUnknown',
  );
  fetchMock.mockResolvedValueOnce(
    Response.json({
      ...recordedCostResponse,
      outcome: 'partial',
      packets: [
        { index: 0, outcome: 'success', networkFeeLamports: '5000' },
        { index: 1, outcome: 'unobserved', networkFeeLamports: null },
      ],
      groupNetworkFeeLamports: '5000',
      knownTotalLamports: '11000',
      feeAndTipCoverageComplete: false,
    }),
  );
  await click('Refresh recorded costs');
  expect(host.textContent).toContain(
    'known fee and tip subtotal. Missing evidence is not zero.',
  );
  expect(host.textContent).toContain('0.000011 SOL');
});
it('recovers non-JSON failures and rejects a successful response for another saved review', async () => {
  fetchMock.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
  await mount();
  await click('Review recorded costs');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'No cost totals',
  );
  fetchMock.mockResolvedValueOnce(
    Response.json({ ...recordedCostResponse, reviewId: 'different' }),
  );
  await click('Retry recorded costs');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'differs',
  );
  expect(host.querySelector('dl')).toBeNull();
  fetchMock.mockResolvedValueOnce(Response.json(recordedCostResponse));
  await click('Retry recorded costs');
  expect(host.textContent).toContain('0.000016 SOL');
});
it('offers sign-in without disclosing stale costs after authentication expires', async () => {
  fetchMock.mockResolvedValueOnce(Response.json(recordedCostResponse));
  await mount();
  await click('Review recorded costs');
  fetchMock.mockResolvedValueOnce(new Response('Expired', { status: 401 }));
  await click('Refresh recorded costs');
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/sign-in');
  expect(host.querySelector('dl')).toBeNull();
});
it('makes hanging reads retryable and ignores late responses after context replacement', async () => {
  vi.useFakeTimers();
  let resolve!: (value: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  await mount();
  await click('Review recorded costs');
  await act(async () => vi.advanceTimersByTime(15_000));
  expect(host.textContent).toContain('took too long');
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await mount('00000002-0000-4000-8000-000000000000');
  await act(async () => resolve(Response.json(recordedCostResponse)));
  expect(host.querySelector('dl')).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain('Review recorded costs');
});
it('cancels active reads and clears their deadline when unmounted', async () => {
  vi.useFakeTimers();
  fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
  await mount();
  await click('Review recorded costs');
  const signal = fetchMock.mock.calls[0][1]?.signal;
  await act(async () => root.unmount());
  expect(signal?.aborted).toBe(true);
  await act(async () => vi.advanceTimersByTime(15_000));
  root = createRoot(host);
});
