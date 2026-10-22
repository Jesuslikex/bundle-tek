import { afterEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { readProviderFundingOrigins } from './wallet-funding-origin-client';
import { decodeFundingOriginBatch } from './wallet-funding-origin-view';
const selection = Array.from({ length: 100 }, (_, i) => ({
  address: bs58.encode(new Uint8Array(32).fill(i + 1)),
  revision: 1,
}));
const body = (wallets = selection, context = wallets) => ({
  context,
  format: 'wallet-funding-origins-v1',
  network: 'mainnet',
  scope: 'oldest-provider-reported-transaction',
  ledgerMetadata: 'provider-reported',
  historyComplete: false,
  signingAllowed: false,
  executionAllowed: false,
  capturedAt: '2026-10-22T00:00:00.000Z',
  wallets: wallets.map((w) => ({
    ...w,
    funding: null,
    reason: 'no-returned-history',
  })),
});
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('checks all 100 selected wallets in ten bounded groups with full post-response gates', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const wallets = JSON.parse(init.body as string).wallets;
    expect(wallets.length).toBeLessThanOrEqual(10);
    return Response.json(body(wallets, selection));
  });
  vi.stubGlobal('fetch', fetcher);
  const progress = vi.fn();
  const result = readProviderFundingOrigins(
    selection,
    new AbortController().signal,
    progress,
  );
  await flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(progress).toHaveBeenLastCalledWith({
    completed: 10,
    total: 100,
    phase: 'waiting',
  });
  for (let i = 1; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(16999);
    expect(fetcher).toHaveBeenCalledTimes(i);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(i + 1);
  }
  expect((await result).wallets.map((w) => w.address)).toEqual(
    selection.map((w) => w.address),
  );
  expect(progress).toHaveBeenLastCalledWith({
    completed: 100,
    total: 100,
    phase: 'complete',
  });
});
it('cancels the gate and does not start another group', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
    Response.json(body(JSON.parse(init.body as string).wallets, selection)),
  );
  vi.stubGlobal('fetch', fetcher);
  const progress = vi.fn();
  const controller = new AbortController();
  const result = readProviderFundingOrigins(
    selection,
    controller.signal,
    progress,
  ).catch((e) => e);
  await flush();
  expect(progress).toHaveBeenLastCalledWith(
    expect.objectContaining({ phase: 'waiting' }),
  );
  controller.abort();
  await result;
  await vi.advanceTimersByTimeAsync(17000);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('stops at the first provider or owner rate limit without an automatic retry', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(body(selection.slice(0, 10), selection)),
    )
    .mockResolvedValueOnce(new Response('private', { status: 429 }));
  vi.stubGlobal('fetch', fetcher);
  const result = readProviderFundingOrigins(
    selection,
    new AbortController().signal,
    () => {},
  ).catch((e) => e);
  await flush();
  await vi.advanceTimersByTimeAsync(17000);
  expect((await result).message).toContain('10 of 100 wallets were read');
  await vi.advanceTimersByTimeAsync(30000);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('rejects a changed revision, wallet, authority flag, ledger source or protocol', () => {
  const original = body(selection.slice(0, 1));
  expect(decodeFundingOriginBatch(original, selection.slice(0, 1))).toEqual(
    original,
  );
  for (const value of [
    { ...original, format: 'wallet-funding-times-v1' },
    { ...original, scope: 'most-recently-saved-native-transfer' },
    { ...original, historyComplete: true },
    { ...original, signingAllowed: true },
    { ...original, executionAllowed: true },
    { ...original, ledgerMetadata: 'verified' },
    { ...original, wallets: [{ ...original.wallets[0], revision: 2 }] },
    {
      ...original,
      wallets: [{ ...original.wallets[0], address: selection[1].address }],
    },
  ])
    expect(() =>
      decodeFundingOriginBatch(value, selection.slice(0, 1)),
    ).toThrow();
});
it('rejects parser/HTML failure without revealing body text or starting another group', async () => {
  const fetcher = vi.fn(
    async () =>
      new Response('<html>private</html>', {
        headers: { 'content-type': 'text/html' },
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(
    readProviderFundingOrigins(
      selection,
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow('could not be checked');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('maps an explicit server timeout without retrying', async () => {
  const fetcher = vi.fn(async () => new Response('private', { status: 408 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(
    readProviderFundingOrigins(
      selection,
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow('timed out');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejects a response that drops the full selection context', async () => {
  const first = selection.slice(0, 10);
  expect(() =>
    decodeFundingOriginBatch(body(first), first, selection),
  ).toThrow();
});
it('does not treat object property order as a changed selection', () => {
  const original = body(selection.slice(0, 1));
  const request = selection
    .slice(0, 1)
    .map((w) => ({ revision: w.revision, address: w.address }));
  expect(
    decodeFundingOriginBatch(original, request, request).wallets,
  ).toHaveLength(1);
});
it('stops a one-MiB overflow before a later request', async () => {
  const fetcher = vi.fn(
    async () =>
      new Response('x'.repeat(1048577), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(
    readProviderFundingOrigins(
      selection,
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow('could not be checked');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('refuses a stale later group without keeping or retrying earlier results', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(body(selection.slice(0, 10), selection)),
    )
    .mockResolvedValueOnce(new Response('private', { status: 409 }));
  vi.stubGlobal('fetch', fetcher);
  const result = readProviderFundingOrigins(
    selection,
    new AbortController().signal,
    () => {},
  ).catch((e) => e);
  await flush();
  await vi.advanceTimersByTimeAsync(17000);
  expect((await result).message).toContain('wallet selection changed');
  expect((await result).message).toContain('No partial result was kept');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('bounds each group read to fifty seconds independently of the overall campaign', async () => {
  const group = new AbortController(),
    campaign = new AbortController();
  const spy = vi
    .spyOn(AbortSignal, 'timeout')
    .mockImplementation((ms) =>
      ms === 50000 ? group.signal : campaign.signal,
    );
  let entered = false;
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    entered = true;
    return new Promise<Response>((_, reject) =>
      init.signal!.addEventListener(
        'abort',
        () => reject(init.signal!.reason),
        { once: true },
      ),
    );
  });
  vi.stubGlobal('fetch', fetcher);
  try {
    const result = readProviderFundingOrigins(
      selection,
      new AbortController().signal,
      () => {},
    ).catch((e) => e);
    for (let i = 0; i < 20 && !entered; i++) await Promise.resolve();
    expect(entered).toBe(true);
    expect(spy).toHaveBeenCalledWith(50000);
    group.abort(new DOMException('Timeout', 'TimeoutError'));
    expect((await result).message).toContain('timed out');
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
});
