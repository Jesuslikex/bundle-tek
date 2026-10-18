// @vitest-environment jsdom
import { act } from 'react';
import { webcrypto } from 'node:crypto';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountLaunchPurchasesPanel } from './account-launch-purchases';
import { accountLaunchPurchasesFixture } from '../test/account-launch-purchases-fixture';
import { launchPurchaseDigest } from '../lib/account-launch-purchases';
let host: HTMLDivElement,
  root: Root,
  f: Awaited<ReturnType<typeof accountLaunchPurchasesFixture>>;
const request = vi.fn<typeof fetch>();
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('crypto', webcrypto);
  f = await accountLaunchPurchasesFixture();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal('fetch', request);
  request.mockReset();
  await mount();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount(withReceipt = true, id = f.context.reviewId) {
  await act(async () =>
    root.render(
      <AccountLaunchPurchasesPanel
        reviewId={id}
        mint={f.context.mint}
        receipt={
          withReceipt
            ? { id: f.context.receiptId, sha256: f.context.receiptSha256 }
            : undefined
        }
      />,
    ),
  );
}
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;
async function click(label: string) {
  expect(button(label)).toBeDefined();
  await act(async () => button(label).click());
}
async function until(text: string) {
  await vi.waitFor(() => expect(host.textContent).toContain(text));
}
async function approve() {
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(),
  );
}
it('stays collapsed and idle, and loads saved history even without a selected receipt', async () => {
  expect(host.querySelector('details')!.open).toBe(false);
  expect(request).not.toHaveBeenCalled();
  await mount(false);
  expect(button('Review these buys').disabled).toBe(true);
  request.mockResolvedValueOnce(Response.json(f.history));
  await click('Load saved buys');
  await until('1 saved buy loaded.');
  expect(request.mock.calls[0][0]).toBe(
    '/api/account-launch-activity/purchases?reviewId=' + f.context.reviewId,
  );
  expect(host.querySelector('input')).toBeNull();
});
it('reviews exact costs, requires explicit consent and submits only review identity once', async () => {
  request.mockResolvedValueOnce(Response.json(f.view));
  await click('Review these buys');
  await until('1 buy verified.');
  expect(button('Save 1 new buy').disabled).toBe(true);
  expect(host.querySelectorAll('details')[1].open).toBe(false);
  await approve();
  request.mockResolvedValueOnce(Response.json(f.saved));
  await click('Save 1 new buy');
  await until('1 buy is already saved.');
  const savedBody = request.mock.calls[1][1]?.body;
  if (typeof savedBody !== 'string') throw new Error('Expected review JSON.');
  expect(JSON.parse(savedBody)).toEqual({
    reviewId: f.context.reviewId,
    receiptId: f.context.receiptId,
    approved: true,
    policy: 'reviewed-buy-shares-v1',
    planSha256: f.view.plan.sha256,
  });
  expect(
    request.mock.calls.filter((c) => c[1]?.method === 'POST'),
  ).toHaveLength(1);
  expect(host.querySelector('input')).toBeNull();
});
it('recovers a lost save by GET without sending a second POST', async () => {
  request.mockResolvedValueOnce(Response.json(f.view));
  await click('Review these buys');
  await until('1 buy verified.');
  await approve();
  request.mockRejectedValueOnce(Error('Lost response'));
  await click('Save 1 new buy');
  await until('last save is unconfirmed');
  expect(button('Save 1 new buy')).toBeUndefined();
  request.mockResolvedValueOnce(Response.json(f.saved));
  await click('Check saved status');
  await until('1 buy is already saved.');
  expect(
    request.mock.calls.filter((c) => c[1]?.method === 'POST'),
  ).toHaveLength(1);
  expect(request.mock.calls[2][1]?.method).toBeUndefined();
});
it('stops a hung response and keeps a late result from publishing after context changes', async () => {
  let late!: (value: Response) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        late = resolve;
      }),
  );
  await click('Review these buys');
  await click('Stop checking');
  expect(host.textContent).toContain('Stopped checking');
  await mount(true, 'cccccccc-cccc-cccc-cccc-cccccccccccc');
  await act(async () => late(Response.json(f.view)));
  expect(host.textContent).not.toContain('1 buy verified');
});
it('releases a hung request on deadline without granting consent or leaving buttons stuck', async () => {
  vi.useFakeTimers();
  request.mockImplementationOnce(() => new Promise(() => {}));
  await click('Review these buys');
  await act(async () => vi.advanceTimersByTime(65001));
  expect(host.textContent).toContain('took too long');
  expect(button('Review these buys').disabled).toBe(false);
  expect(host.querySelector('input')).toBeNull();
});
it('keeps a timed-out write unconfirmed until an explicit saved-status read succeeds', async () => {
  request.mockResolvedValueOnce(Response.json(f.view));
  await click('Review these buys');
  await until('1 buy verified.');
  await approve();
  vi.useFakeTimers();
  request.mockImplementationOnce(() => new Promise(() => {}));
  await click('Save 1 new buy');
  await act(async () => vi.advanceTimersByTime(65001));
  expect(host.textContent).toContain('last save is unconfirmed');
  expect(button('Save 1 new buy')).toBeUndefined();
  vi.useRealTimers();
  request.mockResolvedValueOnce(Response.json(f.saved));
  await click('Check saved status');
  await until('1 buy is already saved.');
  expect(
    request.mock.calls.filter((c) => c[1]?.method === 'POST'),
  ).toHaveLength(1);
});
it('cancels an unfinished response body and refuses oversized replies without rendering their data', async () => {
  let cancelled = false;
  vi.useFakeTimers();
  request.mockResolvedValueOnce(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await click('Review these buys');
  await act(async () => vi.advanceTimersByTime(65001));
  expect(host.textContent).toContain('took too long');
  expect(cancelled).toBe(true);
  vi.useRealTimers();
  request.mockResolvedValueOnce(new Response('x'.repeat(1048577)));
  await click('Review these buys');
  await until('too large');
  expect(host.querySelector('input')).toBeNull();
});
it('clears approval on reload and refuses swapped or HTML responses', async () => {
  request.mockResolvedValueOnce(Response.json(f.view));
  await click('Review these buys');
  await until('1 buy verified.');
  await approve();
  request.mockResolvedValueOnce(
    Response.json({
      ...f.view,
      receiptId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    }),
  );
  await click('Review these buys');
  await until('response differs');
  expect(host.querySelector('input')).toBeNull();
  request.mockResolvedValueOnce(new Response('<html>private error</html>'));
  await click('Review these buys');
  await until('could not be verified');
  expect(host.textContent).not.toContain('private error');
});
it('does not offer duplicate saves and gives a recovery path when a snapshot has no qualified buys', async () => {
  request.mockResolvedValueOnce(
    Response.json({
      ...f.view,
      recordedOriginIds: [f.view.plan.sources[0].originId],
    }),
  );
  await click('Review these buys');
  await until('1 buy is already saved.');
  expect(host.querySelector('input')).toBeNull();
  const unqualified = structuredClone(f.view);
  unqualified.plan.sources = [];
  unqualified.plan.omitted = [
    {
      packetIndex: 0,
      wallet: f.view.plan.sources[0].wallet,
      reason: 'balance-metadata-missing',
    },
  ];
  unqualified.plan.allocationComplete = false;
  unqualified.plan.unallocatedPacketFeesLamports =
    unqualified.plan.knownPacketFeesLamports;
  unqualified.plan.unallocatedSetupFundingLamports =
    unqualified.plan.knownSetupFundingLamports;
  const { sha256: _hash, ...core } = unqualified.plan;
  unqualified.plan.sha256 = await launchPurchaseDigest(core);
  request.mockResolvedValueOnce(Response.json(unqualified));
  await click('Review these buys');
  await until('no verified buys to save');
  expect(host.querySelector('input')).toBeNull();
  expect(button('Load saved buys').disabled).toBe(false);
  request.mockResolvedValueOnce(Response.json({ ...f.history, sources: [] }));
  await click('Load saved buys');
  await until('No buy costs have been saved');
});
it('shows token quote spending separately from SOL fees and handles signed-out/unavailable states', async () => {
  const token = await accountLaunchPurchasesFixture(true);
  request.mockResolvedValueOnce(Response.json(token.view));
  await click('Review these buys');
  await until('1 quote tokens');
  expect(host.textContent).toContain('0.000011 SOL');
  request.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await click('Load saved buys');
  await until('Sign in');
  expect(host.querySelector('input')).toBeNull();
  request.mockResolvedValueOnce(new Response(null, { status: 503 }));
  await click('Load saved buys');
  await until('storage is unavailable');
});
