import { afterEach, expect, it, vi } from 'vitest';
import { createJitoQualificationTransport } from './jito-qualification-transport';
afterEach(() => vi.restoreAllMocks());
const signal = () => new AbortController().signal;
const body = (id = 'a', method = 'getGenesisHash') =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params: [] });
it('binds actual raw responses and reserves ordinary pacing once per batch method', async () => {
  const pace = vi.fn(async (_endpoint: string, _signal: AbortSignal) => {}),
    fetcher = vi.fn(
      async (_u, init) =>
        new Response(
          JSON.stringify(
            JSON.parse(String(init?.body)).map((r: { id: string }) => ({
              jsonrpc: '2.0',
              id: r.id,
              result: 'mainnet',
            })),
          ),
        ),
    );
  const t = createJitoQualificationTransport('bundle', 100, signal(), {
    pace,
    fetcher: fetcher as typeof fetch,
  });
  const request = '[' + body('a') + ',' + body('b') + ']';
  await t.request(request, signal());
  expect(pace).toHaveBeenCalledTimes(2);
  expect(pace.mock.calls.every((c) => c.length === 2)).toBe(true);
  expect(t.captures()[0]).toMatchObject({
    requestBody: request,
    httpStatus: 200,
  });
  expect(t.captures()[0].rawSha256).toHaveLength(64);
  expect(t.summary()).toMatchObject({
    httpReads: 1,
    methodUnits: 2,
    providerQualified: false,
    signingAllowed: false,
  });
  t.close();
});
it('preserves runtime integer bytes while projecting only exact strings to existing decoders', async () => {
  const wire =
    '{"jsonrpc":"2.0","id":"jito-runtime:0","result":{"context":{"slot":101},"value":[{"lamports":18446744073709551615}]}}';
  const t = createJitoQualificationTransport('runtime', 100, signal(), {
    pace: async () => {},
    fetcher: async () => new Response(wire),
  });
  const r = (await t.rpc(
    'getMultipleAccounts',
    [
      ['11111111111111111111111111111111'],
      { encoding: 'base64', commitment: 'confirmed', minContextSlot: 100 },
    ],
    signal(),
  )) as { value: { lamports: string }[] };
  expect(r.value[0].lamports).toBe('18446744073709551615');
  expect(new TextDecoder().decode(t.captures()[0].rawBody)).toBe(wire);
  t.close();
});
for (const kind of ['http', 'rpc'] as const)
  it(`first ${kind}429 stops all subsequent requests and retains a safe reason`, async () => {
    const fetcher = vi.fn(async () =>
      kind === 'http'
        ? new Response(null, { status: 429 })
        : new Response('{"jsonrpc":"2.0","id":null,"error":{"code":429}}'),
    );
    const t = createJitoQualificationTransport('bundle', 100, signal(), {
      pace: async () => {},
      fetcher,
    });
    if (kind === 'http')
      expect((await t.request(body(), signal())).status).toBe(429);
    else await expect(t.request(body(), signal())).rejects.toThrow();
    await expect(t.request(body('later'), signal())).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(t.summary().rateLimited).toBe(true);
  });
it('never admits send/unknown methods, an unbounded account request or an original-window reset', async () => {
  const fetcher = vi.fn();
  const t = createJitoQualificationTransport('bundle', 100, signal(), {
    pace: async () => {},
    fetcher: fetcher as typeof fetch,
  });
  for (const method of ['sendBundle', 'sendTransaction', 'getLatestBlockhash'])
    await expect(t.request(body('x', method), signal())).rejects.toThrow();
  await expect(
    t.rpc(
      'getMultipleAccounts',
      [
        ['11111111111111111111111111111111'],
        { encoding: 'base64', commitment: 'confirmed', minContextSlot: 133 },
      ],
      signal(),
    ),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  t.close();
});
it('enforces the unchanged bundle12HTTP/18method cap', async () => {
  const fetcher = vi.fn(async (_u, init) => {
    const r = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: r.id, result: 'network' }),
    );
  });
  const t = createJitoQualificationTransport('bundle', 100, signal(), {
    pace: async () => {},
    fetcher: fetcher as typeof fetch,
  });
  for (let i = 0; i < 12; i++) await t.request(body('r' + i), signal());
  await expect(t.request(body('extra'), signal())).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(12);
  t.close();
});
it('cancels a late noncooperative response after the owner aborts', async () => {
  const c = new AbortController();
  let release!: (r: Response) => void;
  const cancelled = vi.fn();
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((r) => {
        release = r;
      }),
  );
  const t = createJitoQualificationTransport('runtime', 100, c.signal, {
    pace: async () => {},
    fetcher: fetcher as typeof fetch,
  });
  const pending = t.request(body(), signal());
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  c.abort();
  await expect(pending).rejects.toThrow();
  release(new Response(new ReadableStream({ cancel: cancelled })));
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
  t.close();
});
it('does not continue after a wrong reply identity or a post-read+33 bank', async () => {
  for (const variant of ['id', 'slot']) {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: variant === 'id' ? 'wrong' : 'jito-runtime:0',
            result: { context: { slot: 133 }, value: [] },
          }),
        ),
    );
    const t = createJitoQualificationTransport('runtime', 100, signal(), {
      pace: async () => {},
      fetcher,
    });
    await expect(
      t.rpc(
        'getMultipleAccounts',
        [
          ['11111111111111111111111111111111'],
          { encoding: 'base64', commitment: 'confirmed', minContextSlot: 100 },
        ],
        signal(),
      ),
    ).rejects.toThrow();
    await expect(t.request(body('later'), signal())).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    t.close();
  }
});

it('forbids sliced or unknown asset-config fields before network work', async () => {
  const fetcher = vi.fn();
  const t = createJitoQualificationTransport('assets', 100, signal(), {
    pace: async () => {},
    fetcher: fetcher as typeof fetch,
  });
  for (const extra of [
    { dataSlice: { offset: 0, length: 0 } },
    { unreviewed: true },
  ])
    await expect(
      t.rpc(
        'getMultipleAccounts',
        [
          ['11111111111111111111111111111111'],
          {
            encoding: 'base64',
            commitment: 'confirmed',
            minContextSlot: 100,
            ...extra,
          },
        ],
        signal(),
      ),
    ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  t.close();
});
it('labels a200 response without admissible bounded bytes as not captured', async () => {
  const t = createJitoQualificationTransport('assets', 100, signal(), {
    pace: async () => {},
    fetcher: async () => new Response(' '.repeat(131073)),
  });
  await expect(
    t.request(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'oversize',
        method: 'getMultipleAccounts',
        params: [
          ['11111111111111111111111111111111'],
          { encoding: 'base64', commitment: 'confirmed', minContextSlot: 100 },
        ],
      }),
      signal(),
    ),
  ).rejects.toThrow();
  expect(t.captures()[0]).toMatchObject({
    httpStatus: 200,
    captureStatus: 'not-captured',
    rawSha256: '',
  });
  t.close();
});

it('keeps runtime/asset stages single-method and rejects noncanonical account keys', async () => {
  const fetcher = vi.fn();
  for (const stage of ['runtime', 'assets'] as const) {
    const t = createJitoQualificationTransport(stage, 100, signal(), {
      pace: async () => {},
      fetcher: fetcher as typeof fetch,
    });
    await expect(
      t.request('[' + body('a') + ',' + body('b') + ']', signal()),
    ).rejects.toThrow();
    await expect(
      t.rpc(
        'getMultipleAccounts',
        [
          [7],
          { encoding: 'base64', commitment: 'confirmed', minContextSlot: 100 },
        ],
        signal(),
      ),
    ).rejects.toThrow();
    t.close();
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it('separates fractional monotonic pacing, observed headers and a deliberately delayed body without admission authority', async () => {
  let now = 100.25;
  let releaseBody!: () => void;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const t = createJitoQualificationTransport('bundle', 100, signal(), {
    pace: async () => {
      now = 110.375;
    },
    fetcher: async () => {
      expect(now).toBe(110.375);
      now = 120.5;
      return new Response(
        new ReadableStream({
          start(controller) {
            releaseBody = () => {
              now = 130.75;
              controller.enqueue(
                new TextEncoder().encode(
                  '{"jsonrpc":"2.0","id":"a","result":"mainnet"}',
                ),
              );
              controller.close();
            };
          },
        }),
      );
    },
  });
  const pending = t.request(body(), signal());
  await vi.waitFor(() =>
    expect(t.captures()[0]?.timing.headersAtMs).toBe(20.25),
  );
  expect(t.captures()[0].timing.capturedAtMs).toBeNull();
  releaseBody();
  await pending;
  const capture = t.captures()[0];
  expect(capture.timing).toEqual({
    queuedAtMs: 0,
    pacedAtMs: 10.125,
    sentAtMs: 10.125,
    headersAtMs: 20.25,
    capturedAtMs: 30.5,
    finishedAtMs: 30.5,
  });
  expect(t.summary().timing).toEqual({
    clock: 'process-monotonic',
    originMs: 100.25,
    diagnosticOnly: true,
  });
  expect(t.summary()).toMatchObject({
    httpReads: 1,
    methodUnits: 1,
    signingAllowed: false,
    executionAllowed: false,
  });
  capture.timing.finishedAtMs = 999;
  expect(t.captures()[0].timing.finishedAtMs).toBe(30.5);
  t.close();
});
it.each(['http', 'rpc'] as const)(
  'retains completed refusal timing on %s429 without a retry',
  async (kind) => {
    const fetcher = vi.fn(async () =>
      kind === 'http'
        ? new Response(null, { status: 429 })
        : new Response('{"jsonrpc":"2.0","id":null,"error":{"code":429}}'),
    );
    const t = createJitoQualificationTransport('bundle', 100, signal(), {
      pace: async () => {},
      fetcher,
    });
    if (kind === 'http')
      expect((await t.request(body(), signal())).status).toBe(429);
    else await expect(t.request(body(), signal())).rejects.toThrow();
    const captured = t.captures()[0];
    expect(captured.timing.finishedAtMs).not.toBeNull();
    expect(captured.timing.headersAtMs).not.toBeNull();
    expect(captured.timing.capturedAtMs === null).toBe(kind === 'http');
    await expect(t.request(body('later'), signal())).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(t.captures()[0].timing).toEqual(captured.timing);
  },
);
it('does not turn a late uncooperative response into successful timing evidence after cancellation', async () => {
  const c = new AbortController();
  let release!: (r: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((r) => {
        release = r;
      }),
  );
  const t = createJitoQualificationTransport('runtime', 100, c.signal, {
    pace: async () => {},
    fetcher,
  });
  const pending = t.request(body(), signal());
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  c.abort();
  await expect(pending).rejects.toThrow();
  const before = t.captures()[0].timing;
  expect(before.headersAtMs).toBeNull();
  expect(before.capturedAtMs).toBeNull();
  expect(before.finishedAtMs).not.toBeNull();
  const cancelled = vi.fn();
  release(new Response(new ReadableStream({ cancel: cancelled })));
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  expect(t.captures()[0].timing).toEqual(before);
});
