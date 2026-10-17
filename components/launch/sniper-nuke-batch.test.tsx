// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SniperNukeBatchPanel } from './sniper-nuke-batch';
import type { SniperNukeBatch } from '@/lib/sniper-nuke';

const REVIEW = '6f1c2e8a-1d2b-4c3d-9e4f-5a6b7c8d9e0f';
const batch = (state: string): SniperNukeBatch =>
  ({
    batchId: 'b1',
    reviewId: REVIEW,
    guardId: 'g',
    sells: [
      {
        id: 's1',
        wallet: 'W1',
        state,
        signature: null,
        review: {
          inputRaw: '5000000',
          minimumOutputRaw: '1000',
          maximumFeeLamports: '5000',
          sha256: 'a',
        },
      },
    ],
    skipped: [{ wallet: 'W2', reason: 'No tokens to sell.' }],
  }) as unknown as SniperNukeBatch;

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  )!;

it('prepares a batch and lists sells and skipped wallets', async () => {
  const fetch = vi.fn(
    async () => new Response(JSON.stringify(batch('review'))),
  );
  vi.stubGlobal('fetch', fetch);
  act(() =>
    root.render(<SniperNukeBatchPanel reviewId={REVIEW} initial={null} />),
  );
  await act(async () => button('Prepare Nuke sells').click());
  expect(
    JSON.parse(
      (fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body,
    ),
  ).toEqual({
    action: 'nuke-prepare',
    reviewId: REVIEW,
  });
  expect(host.textContent).toContain('Ready to approve');
  expect(host.textContent).toContain('Not included: No tokens to sell.');
  expect(button('Sign all 1 sells').disabled).toBe(true);
});

it('sends each signed sell once, only on click', async () => {
  const fetch = vi.fn(
    async () => new Response(JSON.stringify(batch('submitted'))),
  );
  vi.stubGlobal('fetch', fetch);
  act(() =>
    root.render(
      <SniperNukeBatchPanel reviewId={REVIEW} initial={batch('signed')} />,
    ),
  );
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => button('Send 1 signed sells').click());
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(
      (fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body,
    ),
  ).toEqual({
    action: 'nuke-send',
    batchId: 'b1',
    sellId: 's1',
    reviewId: REVIEW,
  });
  expect(host.textContent).toContain('Sent');
});
