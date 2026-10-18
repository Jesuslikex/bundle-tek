// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountLaunchEvidencePanel } from './account-launch-evidence';
import {
  recordedCostReviewId as reviewId,
  recordedCostMint as mint,
} from '@/test/pump-group-recorded-costs-fixture';
const response = {
  reviewId,
  mint,
  entry: {
    id: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12),
    sha256: 'b'.repeat(64),
    observedAt: '2026-10-18T12:00:00.000Z',
    packetCount: 3,
    successfulPackets: 1,
    failedPackets: 1,
    missingPackets: 1,
    instructionMetadataPackets: 1,
    balanceCoverageComplete: false,
    acquisitionBasisVerified: false,
    executionAllowed: false,
  },
};
let host: HTMLDivElement, root: Root;
const request = vi.fn<typeof fetch>();
const mount = async (id = reviewId) => {
  await act(async () =>
    root.render(<AccountLaunchEvidencePanel reviewId={id} mint={mint} />),
  );
};
const click = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  request.mockReset();
  vi.stubGlobal('fetch', request);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('starts collapsed with no requests and reloads saved evidence by GET only', async () => {
  await mount();
  expect(request).not.toHaveBeenCalled();
  expect(host.querySelector('details')?.open).toBe(false);
  request.mockResolvedValueOnce(Response.json(response));
  await click('Load saved evidence');
  expect(request).toHaveBeenCalledWith(
    '/api/account-launch-activity/evidence?reviewId=' + reviewId,
    expect.objectContaining({
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    }),
  );
  expect(host.textContent).toContain('1 successful, 1 failed, 1 not observed');
  expect(host.textContent).toContain(
    'Acquisition cost and launch profit are not verified',
  );
});
it('keeps the same save identity after an uncertain error and clears it only after confirmation', async () => {
  await mount();
  request.mockResolvedValueOnce(
    new Response('<html>offline</html>', { status: 503 }),
  );
  await click('Save finalized receipts');
  const body = request.mock.calls[0][1]?.body;
  if (typeof body !== 'string')
    throw new Error('Expected a JSON request body.');
  const first = JSON.parse(body);
  expect(Object.keys(first).sort()).toEqual(['requestId', 'reviewId']);
  expect(first.reviewId).toBe(reviewId);
  request.mockResolvedValueOnce(
    Response.json({
      ...response,
      entry: { ...response.entry, id: first.requestId },
    }),
  );
  await click('Save finalized receipts');
  expect(request.mock.calls[1][1]?.body).toBe(request.mock.calls[0][1]?.body);
  request.mockResolvedValueOnce(Response.json(response));
  await click('Save finalized receipts');
  expect(request.mock.calls[2][1]?.body).not.toBe(
    request.mock.calls[0][1]?.body,
  );
  expect(
    request.mock.calls.every(
      ([url]) => url === '/api/account-launch-activity/evidence',
    ),
  ).toBe(true);
});
it('shows no invented receipt totals for empty, invalid, wrong-context or permission-bearing responses', async () => {
  await mount();
  request.mockResolvedValueOnce(Response.json({ ...response, entry: null }));
  await click('Load saved evidence');
  expect(host.textContent).toContain('No receipt snapshot is saved yet');
  for (const value of [
    { ...response, mint: 'bad' },
    { ...response, entry: { ...response.entry, executionAllowed: true } },
    { ...response, entry: { ...response.entry, successfulPackets: 5 } },
  ]) {
    request.mockResolvedValueOnce(Response.json(value));
    await click('Load saved evidence');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Saved receipt snapshot:');
  }
});
it('cancels stale context requests and keeps sign-in and retry actions reachable', async () => {
  let resolve!: (r: Response) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await mount();
  await click('Load saved evidence');
  const abort = request.mock.calls[0][1]?.signal as AbortSignal;
  await mount('cccccccc-cccc-cccc-cccc-cccccccccccc');
  expect(abort.aborted).toBe(true);
  await act(async () => resolve(Response.json(response)));
  expect(host.textContent).not.toContain('Saved receipt snapshot:');
  request.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await click('Load saved evidence');
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/sign-in');
  request.mockResolvedValueOnce(new Response(null, { status: 429 }));
  await click('Save finalized receipts');
  expect(host.textContent).toContain('Wait five seconds');
  expect(host.querySelectorAll('button:disabled')).toHaveLength(0);
});
it('times out pending requests without losing the exact retry identity', async () => {
  vi.useFakeTimers();
  request.mockImplementationOnce(() => new Promise(() => {}));
  await mount();
  await click('Save finalized receipts');
  const first = request.mock.calls[0][1];
  if (!first?.signal) throw new Error('Expected a cancellable request.');
  await act(async () => vi.advanceTimersByTime(50_000));
  expect(first.signal.aborted).toBe(true);
  expect(host.textContent).toContain('took too long');
  request.mockResolvedValueOnce(Response.json(response));
  await click('Save finalized receipts');
  expect(request.mock.calls[1][1]?.body).toBe(first?.body);
});
