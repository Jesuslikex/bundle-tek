import { afterEach, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { createExchangeOrderTransport } from './exchange-order-transport';
const addr = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const request = () => ({
  currency: 'sol',
  network: 'sol',
  toAmount: '1.1',
  address: addr(7),
  refundAddress: addr(8),
  rateId: 'private-rate-fixture',
});
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());
it('requires explicit enablement and a server key before any transport exists', () => {
  const fetcher = vi.fn<typeof fetch>();
  for (const options of [
    {},
    { key: 'fixture' },
    { enabled: true },
    { enabled: true, key: 'secret\r\nheader' },
    { enabled: true, key: 'x'.repeat(4097) },
  ])
    expect(() =>
      createExchangeOrderTransport({ ...options, fetchImpl: fetcher }),
    ).toThrow('not configured');
  expect(fetcher).not.toHaveBeenCalled();
});
it('pins the native SOL POST body and header-only key, with no redirects or caching', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      id: 'providerfixture',
      fromAmount: '1.15',
      toAmount: '1.1',
    }),
  );
  const transport = createExchangeOrderTransport({
    enabled: true,
    key: 'server-fixture-key',
    fetchImpl: fetcher,
  });
  await transport.create(request(), signal());
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('https://api.changenow.io/v2/private-transfer');
  expect(init).toMatchObject({
    method: 'POST',
    redirect: 'manual',
    cache: 'no-store',
    headers: {
      'x-changenow-api-key': 'server-fixture-key',
      'content-type': 'application/json',
    },
  });
  expect(JSON.parse(init!.body as string)).toEqual(request());
  expect(url).not.toContain('server-fixture-key');
  for (const body of [
    { ...request(), network: 'eth' },
    { ...request(), providerUrl: 'https://bad.test' },
    { ...request(), address: addr(8) },
    { ...request(), toAmount: '1e3' },
    { ...request(), rateId: '\r\nother' },
    { ...request(), signedTransaction: 'packet' },
  ])
    await expect(transport.create(body, signal())).rejects.toMatchObject({
      status: 400,
    });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('uses only a validated retained reference for a read-only lookup', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ id: 'providerfixture' }),
  );
  const transport = createExchangeOrderTransport({
    enabled: true,
    key: 'fixture',
    fetchImpl: fetcher,
  });
  await transport.lookup('provider_fixture-1', signal());
  expect(fetcher.mock.calls[0]).toEqual([
    'https://api.changenow.io/v2/exchange/by-id?id=provider_fixture-1',
    expect.objectContaining({
      method: 'GET',
      cache: 'no-store',
      redirect: 'manual',
    }),
  ]);
  for (const id of [
    'https://bad.test',
    'a&key=secret',
    '../order',
    'x'.repeat(81),
  ])
    await expect(transport.lookup(id, signal())).rejects.toMatchObject({
      status: 400,
    });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('preserves decimal spelling from numeric JSON before floating-point rounding and keeps string amounts exact', async () => {
  const transport = createExchangeOrderTransport({
    enabled: true,
    key: 'fixture',
    fetchImpl: async () =>
      new Response(
        '{"id":"providerfixture","expectedAmountFrom":9007199.254740993,"expectedAmountTo":0.000000001,"fromAmount":"1.150000000","toAmount":"1.100000000"}',
      ),
  });
  expect(await transport.lookup('providerfixture', signal())).toEqual({
    id: 'providerfixture',
    expectedAmountFrom: '9007199.254740993',
    expectedAmountTo: '0.000000001',
    fromAmount: '1.150000000',
    toAmount: '1.100000000',
  });
});
it.each(['1e-9', '1.0000000001', '-1'])(
  'refuses unqualified numeric amount %s instead of rounding it',
  async (token) => {
    const transport = createExchangeOrderTransport({
      enabled: true,
      key: 'fixture',
      fetchImpl: async () => new Response('{"toAmount":' + token + '}'),
    });
    await expect(
      transport.lookup('providerfixture', signal()),
    ).rejects.toMatchObject({ status: 502 });
  },
);
it.each([429, 302, 401, 500])(
  'does not retry or expose response content for HTTP%s',
  async (status) => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response('secret fixture key and private URL', { status }),
    );
    const transport = createExchangeOrderTransport({
      enabled: true,
      key: 'fixture',
      fetchImpl: fetcher,
    });
    const error = await transport
      .lookup('providerfixture', signal())
      .catch((error) => error);
    expect(error).toMatchObject({ status: status === 429 ? 429 : 503 });
    expect(String(error)).not.toContain('secret fixture');
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it.each(['x'.repeat(65537), '<html>private diagnostic</html>', 'null', '[]'])(
  'refuses oversized, HTML or incomplete provider data',
  async (text) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(text));
    const transport = createExchangeOrderTransport({
      enabled: true,
      key: 'fixture',
      fetchImpl: fetcher,
    });
    await expect(
      transport.lookup('providerfixture', signal()),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it('settles cancellation and the whole body deadline even if the provider ignores abort', async () => {
  vi.useFakeTimers();
  let child!: AbortSignal;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    child = init!.signal!;
    return new Promise<Response>(() => {});
  });
  const transport = createExchangeOrderTransport({
      enabled: true,
      key: 'fixture',
      fetchImpl: fetcher,
    }),
    controller = new AbortController();
  const pending = transport.lookup('providerfixture', controller.signal),
    refusal = expect(pending).rejects.toMatchObject({ status: 503 });
  controller.abort();
  await refusal;
  expect(child.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{'));
    },
    cancel() {
      return new Promise<void>(() => {});
    },
  });
  fetcher.mockImplementationOnce(async () => new Response(body));
  const read = transport.lookup('providerfixture', signal()),
    deadline = expect(read).rejects.toMatchObject({ status: 503 });
  await vi.advanceTimersByTimeAsync(15000);
  await deadline;
  expect(vi.getTimerCount()).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
