import { afterEach, expect, it, vi } from 'vitest';
import { readHolderIndexPageWithRetry } from './holder-index-retry';
const query = {
  id: 'project',
  revision: 1,
  runId: '00000000-0000-4000-8000-000000000001',
  page: 2,
};
const success = () => Response.json({ ...query, page: { page: 2 } });
it('rejects a response that changes the selected scan mode without retrying', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json({ ...query, page: { page: 2, enumeration: 'das-cursor' } }),
    );
  vi.stubGlobal('fetch', fetcher);
  await expect(
    readHolderIndexPageWithRetry(
      { ...query, enumeration: 'program-accounts-v2' },
      new AbortController().signal,
    ),
  ).rejects.toThrow('differs');
  expect(fetcher).toHaveBeenCalledOnce();
});
it('recovers a timed-out read while keeping user cancellation distinct', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const timeout = new AbortController();
  vi.spyOn(AbortSignal, 'timeout')
    .mockReturnValueOnce(timeout.signal)
    .mockReturnValue(new AbortController().signal);
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      async (_input, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener(
            'abort',
            () => reject(init.signal!.reason),
            { once: true },
          );
        }),
    )
    .mockResolvedValueOnce(success());
  vi.stubGlobal('fetch', fetcher);
  const retry = vi.fn();
  const result = readHolderIndexPageWithRetry(
    query,
    new AbortController().signal,
    retry,
  );
  timeout.abort(new DOMException('Timed out', 'TimeoutError'));
  await vi.advanceTimersByTimeAsync(2000);
  await expect(result).resolves.toMatchObject({ page: { page: 2 } });
  expect(retry).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: 'Holder page read timed out.',
      attempt: 1,
    }),
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('does not issue a provider request for an already-expired saved run', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(
    readHolderIndexPageWithRetry(
      query,
      new AbortController().signal,
      () => {},
      Date.now() - 1,
    ),
  ).rejects.toThrow('resume window expired');
  expect(fetcher).not.toHaveBeenCalled();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('retries the identical saved page after Retry-After without advancing its body', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { error: 'Rate limited' },
        { status: 429, headers: { 'retry-after': '3' } },
      ),
    )
    .mockResolvedValueOnce(success());
  vi.stubGlobal('fetch', fetcher);
  const onRetry = vi.fn();
  const result = readHolderIndexPageWithRetry(
    query,
    new AbortController().signal,
    onRetry,
  );
  await vi.advanceTimersByTimeAsync(2999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(onRetry).toHaveBeenCalledWith({
    attempt: 1,
    delayMs: 3000,
    page: 2,
    reason: 'Rate limited',
  });
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toMatchObject({
    runId: query.runId,
    page: { page: 2 },
  });
  expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
});
it.each([401, 403, 409])(
  'does not retry authorization or context status %s',
  async (status) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: 'Context changed' }, { status }),
      );
    vi.stubGlobal('fetch', fetcher);
    await expect(
      readHolderIndexPageWithRetry(query, new AbortController().signal),
    ).rejects.toThrow('Context changed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it('stops rather than waiting past the saved scan resume window', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: 'Slow down' },
          { status: 429, headers: { 'retry-after': '120' } },
        ),
      ),
  );
  const notify = vi.fn();
  await expect(
    readHolderIndexPageWithRetry(
      query,
      new AbortController().signal,
      notify,
      Date.now() + 60000,
    ),
  ).rejects.toThrow('resume window');
  expect(notify).not.toHaveBeenCalled();
});
it('cancels a pending retry without another request', async () => {
  vi.useFakeTimers();
  const c = new AbortController();
  const fetcher = vi.fn().mockRejectedValue(new TypeError('Lost response'));
  vi.stubGlobal('fetch', fetcher);
  const result = readHolderIndexPageWithRetry(query, c.signal).catch(
    (error) => error,
  );
  await vi.advanceTimersByTimeAsync(0);
  c.abort();
  await result;
  await vi.advanceTimersByTimeAsync(60000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('exhausts its bounded retries, retaining the original page identity', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const fetcher = vi
    .fn()
    .mockImplementation(async () =>
      Response.json({ error: 'Temporary provider failure' }, { status: 502 }),
    );
  vi.stubGlobal('fetch', fetcher);
  const result = readHolderIndexPageWithRetry(
    query,
    new AbortController().signal,
  ).catch((error) => error);
  await vi.advanceTimersByTimeAsync(14000);
  expect((await result).message).toBe('Temporary provider failure');
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(new Set(fetcher.mock.calls.map((call) => call[1].body)).size).toBe(1);
});
it.each(['invalid-json', 'wrong-run', 'wrong-page'])(
  'does not retry malformed successful %s data',
  async (kind) => {
    const response =
      kind === 'invalid-json'
        ? new Response('{')
        : Response.json({
            ...query,
            runId: kind === 'wrong-run' ? 'other' : query.runId,
            page: { page: kind === 'wrong-page' ? 3 : 2 },
          });
    const fetcher = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetcher);
    await expect(
      readHolderIndexPageWithRetry(query, new AbortController().signal),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
