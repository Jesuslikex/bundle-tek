import { afterEach, expect, it, vi } from 'vitest';
import { createPairReadRpc } from './pair-read-rpc';
import { WalletRpcError } from './wallet-balances';
import { paceWalletRpc } from './wallet-rpc-pacing';
import { pairRuntimeFixture } from '../test/pair-runtime-fixture';
import { previewOwnedImportedPairRuntime } from './imported-pair-runtime';
vi.mock('./wallet-rpc-pacing', () => ({
  paceWalletRpc: vi.fn(async (_endpoint: string, signal: AbortSignal) =>
    signal.throwIfAborted(),
  ),
}));
const endpoint = 'https://rpc.example.test/';
type Message = {
  jsonrpc: string;
  id: string;
  method: string;
  params: unknown[];
};
const pending: ReturnType<typeof createPairReadRpc>[] = [];
function requestBody(init?: RequestInit) {
  if (typeof init?.body !== 'string')
    throw Error('Expected JSON request body.');
  return init.body;
}
afterEach(() => {
  for (const r of pending.splice(0)) r.close();
  vi.mocked(paceWalletRpc).mockClear();
});
function fixture(
  transform?: (reply: unknown[], messages: Message[]) => unknown,
) {
  const bodies: Message[][] = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(requestBody(init)),
      messages = (Array.isArray(body) ? body : [body]) as Message[];
    bodies.push(messages);
    const replies = messages.map((m) => ({
      jsonrpc: '2.0',
      id: m.id,
      result:
        m.method === 'getMultipleAccounts'
          ? { context: { slot: '123' }, value: [] }
          : ['getBlockHeight', 'getSlot'].includes(m.method)
            ? '123'
            : 'genesis',
    }));
    return Response.json(
      transform
        ? transform(replies, messages)
        : Array.isArray(body)
          ? replies
          : replies[0],
    );
  });
  const controller = new AbortController(),
    reader = createPairReadRpc(
      endpoint,
      controller.signal,
      fetcher as typeof fetch,
    );
  pending.push(reader);
  return { reader, fetcher, bodies, controller };
}
it('batches two independent calls and preserves floors and exact response order', async () => {
  const f = fixture();
  expect(
    await Promise.all([
      f.reader.rpc('getGenesisHash', []),
      f.reader.rpc('getBlockHeight', [
        { commitment: 'confirmed', minContextSlot: 100 },
      ]),
    ]),
  ).toEqual(['genesis', '123']);
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(paceWalletRpc).toHaveBeenCalledOnce();
  expect(f.bodies[0][1].params).toEqual([
    { commitment: 'confirmed', minContextSlot: 100 },
  ]);
  expect(f.fetcher.mock.calls[0][1]).toMatchObject({
    redirect: 'manual',
    cache: 'no-store',
    method: 'POST',
  });
});
it.each([
  'missing',
  'duplicate',
  'unknown',
  'numeric-id',
  'wrong-version',
  'one-error',
  'not-array',
  'reordered',
] as const)(
  'rejects the whole %s batch without retry or partial publication',
  async (mode) => {
    const f = fixture((replies) => {
      const r = replies as {
        id: unknown;
        jsonrpc: string;
        result?: unknown;
        error?: unknown;
      }[];
      if (mode === 'missing') r.pop();
      if (mode === 'duplicate') r[1].id = r[0].id;
      if (mode === 'unknown') r[1].id = 'not-requested';
      if (mode === 'numeric-id') r[1].id = 2;
      if (mode === 'wrong-version') r[1].jsonrpc = '1.0';
      if (mode === 'reordered') r.reverse();
      if (mode === 'one-error')
        r[1].error = { code: -32603, message: 'private provider detail' };
      return mode === 'not-array' ? r[0] : r;
    });
    const results = await Promise.allSettled([
      f.reader.rpc('getGenesisHash', []),
      f.reader.rpc('getBlockHeight', [{ commitment: 'confirmed' }]),
    ]);
    expect(results.every((x) => x.status === 'rejected')).toBe(true);
    expect(f.fetcher).toHaveBeenCalledOnce();
    await expect(
      f.reader.rpc('getSlot', [{ commitment: 'confirmed' }]),
    ).rejects.toThrow('Pair RPC batch read failed.');
    expect(f.fetcher).toHaveBeenCalledOnce();
  },
);
it('retains exact u64 numeric spelling', async () => {
  const f = fixture();
  f.fetcher.mockImplementation(async (_url, init) => {
    const messages = JSON.parse(requestBody(init)) as Message[];
    return new Response(
      '[' +
        messages
          .map(
            (m) =>
              '' +
              JSON.stringify({
                jsonrpc: '2.0',
                id: m.id,
                result: '18446744073709551615',
              }).replace('"18446744073709551615"', '18446744073709551615'),
          )
          .join(',') +
        ']',
    );
  });
  expect(
    await Promise.all([
      f.reader.rpc('getBlockHeight', [{}]),
      f.reader.rpc('getSlot', [{}]),
    ]),
  ).toEqual(['18446744073709551615', '18446744073709551615']);
});
it.each(
  [
    'getSlot',
    'getMultipleAccounts',
    'getFeeForMessage',
    'isBlockhashValid',
  ].flatMap((method) =>
    [99, 133, 'not-a-slot'].map((slot) => ({ method, slot })),
  ),
)(
  'refuses the entire $method batch for its own invalid slot $slot',
  async ({ method, slot }) => {
    const f = fixture();
    f.fetcher.mockImplementation(async (_url, init) => {
      const messages = JSON.parse(requestBody(init)) as Message[];
      return Response.json(
        messages.map((m) => ({
          jsonrpc: '2.0',
          id: m.id,
          result:
            m.method === 'getGenesisHash'
              ? 'genesis'
              : m.method === 'getSlot'
                ? slot
                : { context: { slot }, value: [] },
        })),
      );
    });
    const config = {
      encoding: 'base64',
      commitment: 'confirmed',
      minContextSlot: 100,
      dataSlice: { offset: 0, length: 45 },
    };
    const params =
      method === 'getSlot'
        ? [config]
        : method === 'getMultipleAccounts'
          ? [['11111111111111111111111111111111'], config]
          : ['message', config];
    const results = await Promise.allSettled([
      f.reader.rpc('getGenesisHash', []),
      f.reader.rpc(method, params),
    ]);
    expect(results.every((x) => x.status === 'rejected')).toBe(true);
    expect(f.fetcher).toHaveBeenCalledOnce();
  },
);
it('validates each ordered response against its distinct floor, without replacing either floor', async () => {
  const f = fixture();
  f.fetcher.mockImplementation(async (_url, init) => {
    const messages = JSON.parse(requestBody(init)) as Message[];
    return Response.json(
      messages.map((m, i) => ({
        jsonrpc: '2.0',
        id: m.id,
        result: { context: { slot: i === 0 ? 105 : 112 }, value: true },
      })),
    );
  });
  const result = await Promise.all([
    f.reader.rpc('getFeeForMessage', ['message', { minContextSlot: 100 }]),
    f.reader.rpc('isBlockhashValid', ['blockhash', { minContextSlot: 110 }]),
  ]);
  expect(result).toMatchObject([
    { context: { slot: '105' } },
    { context: { slot: '112' } },
  ]);
  const body = JSON.parse(requestBody(f.fetcher.mock.calls[0][1])) as Message[];
  expect(
    body.map((m) => (m.params[1] as { minContextSlot: number }).minContextSlot),
  ).toEqual([100, 110]);
});
it('checks the original-packet simulation response against its own floor', async () => {
  const f = fixture();
  f.fetcher.mockImplementation(async (_url, init) => {
    const m = JSON.parse(requestBody(init)) as Message;
    return Response.json({
      jsonrpc: '2.0',
      id: m.id,
      result: { context: { slot: 99 }, value: { err: null } },
    });
  });
  await expect(
    f.reader.rpc('simulateTransaction', [
      'packet',
      { minContextSlot: 100, sigVerify: false, replaceRecentBlockhash: false },
    ]),
  ).rejects.toThrow('Pair RPC batch read failed.');
  expect(f.fetcher).toHaveBeenCalledOnce();
});
it('uses at most two methods in an HTTP request', async () => {
  const f = fixture();
  await Promise.all(
    Array.from({ length: 5 }, () => f.reader.rpc('getGenesisHash', [])),
  );
  expect(f.bodies.map((x) => x.length)).toEqual([2, 2, 1]);
  expect(paceWalletRpc).toHaveBeenCalledTimes(3);
  expect(new Set(f.bodies.flat().map((x) => x.id)).size).toBe(5);
});
it('freezes parameters before queueing', async () => {
  const f = fixture(),
    keys = ['11111111111111111111111111111111'],
    config = {
      encoding: 'base64',
      commitment: 'confirmed',
      minContextSlot: 100,
      dataSlice: { offset: 0, length: 45 },
    };
  const run = f.reader.programRpc('getMultipleAccounts', [keys, config]);
  keys[0] = 'changed';
  config.minContextSlot = 1;
  config.dataSlice.length = 1;
  await run;
  expect(f.bodies[0][0].params).toEqual([
    ['11111111111111111111111111111111'],
    {
      encoding: 'base64',
      commitment: 'confirmed',
      minContextSlot: 100,
      dataSlice: { offset: 0, length: 45 },
    },
  ]);
});
it('preserves a provider 429 and trips the request circuit instead of retrying', async () => {
  const f = fixture();
  f.fetcher.mockResolvedValue(new Response('private detail', { status: 429 }));
  const r = await Promise.allSettled([
    f.reader.rpc('getGenesisHash', []),
    f.reader.rpc('getBlockHeight', [{}]),
  ]);
  for (const result of r) {
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected')
      expect(result.reason).toBeInstanceOf(WalletRpcError);
  }
  await expect(f.reader.rpc('getGenesisHash', [])).rejects.toMatchObject({
    status: 429,
  });
  expect(f.fetcher).toHaveBeenCalledOnce();
});
it('cancels a fetch that ignores abort and refuses subsequent reads', async () => {
  const f = fixture();
  let started = () => {};
  const fetching = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.fetcher.mockImplementation(() => {
    started();
    return new Promise<Response>(() => {});
  });
  const work = Promise.allSettled([
    f.reader.rpc('getGenesisHash', []),
    f.reader.rpc('getSlot', [{}]),
  ]);
  await fetching;
  f.controller.abort();
  expect((await work).every((x) => x.status === 'rejected')).toBe(true);
  await expect(f.reader.rpc('getSlot', [{}])).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(f.fetcher).toHaveBeenCalledOnce();
});
it('cancels a stalled response body', async () => {
  const f = fixture(),
    cancel = vi.fn();
  let started = () => {};
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.fetcher.mockResolvedValue(
    new Response(
      new ReadableStream(
        {
          pull() {
            started();
            return new Promise<void>(() => {});
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
    ),
  );
  const work = Promise.allSettled([
    f.reader.rpc('getGenesisHash', []),
    f.reader.rpc('getSlot', [{}]),
  ]);
  await reading;
  f.controller.abort();
  expect((await work).every((x) => x.status === 'rejected')).toBe(true);
  expect(cancel).toHaveBeenCalled();
});
it('enforces the original normal bound on a whole mixed-profile batch', async () => {
  const f = fixture(),
    cancel = vi.fn();
  f.fetcher.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(524289).fill(32));
        },
        cancel,
      }),
      { headers: { 'content-length': '2' } },
    ),
  );
  const results = await Promise.allSettled([
    f.reader.rpc('getGenesisHash', []),
    f.reader.programRpc('getMultipleAccounts', [
      ['11111111111111111111111111111111'],
      { encoding: 'base64', dataSlice: { offset: 0, length: 45 } },
    ]),
  ]);
  expect(results.every((x) => x.status === 'rejected')).toBe(true);
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalled();
});
it('packs a small full-account read while preserving its whole-envelope byte bound', async () => {
  const f = fixture();
  await Promise.all([
    f.reader.rpc('getMultipleAccounts', [
      ['11111111111111111111111111111111'],
      { encoding: 'base64' },
    ]),
    f.reader.rpc('getGenesisHash', []),
  ]);
  expect(f.bodies.map((x) => x.length)).toEqual([2]);
});
it('cancels an underestimated full-account batch before publishing either result', async () => {
  const f = fixture(),
    cancel = vi.fn();
  f.fetcher.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(524289).fill(32));
        },
        cancel,
      }),
    ),
  );
  const results = await Promise.allSettled([
    f.reader.rpc('getMultipleAccounts', [
      ['11111111111111111111111111111111'],
      { encoding: 'base64' },
    ]),
    f.reader.rpc('getGenesisHash', []),
  ]);
  expect(f.bodies).toHaveLength(0); // mock records no bodies; fetch count proves one envelope.
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(JSON.parse(requestBody(f.fetcher.mock.calls[0][1]))).toHaveLength(2);
  expect(results.every((r) => r.status === 'rejected')).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
});
it.each([360, 720])(
  'preserves the 1-MiB raw envelope cap for two %i-KiB slices',
  async (kib) => {
    const f = fixture();
    f.fetcher.mockImplementation(async (_url, init) => {
      const body = JSON.parse(requestBody(init)),
        messages = Array.isArray(body) ? body : [body];
      const replies = messages.map((m: Message) => ({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          context: { slot: 100 },
          value: [
            {
              data: [Buffer.alloc(kib * 1024).toString('base64'), 'base64'],
              space: kib * 1024,
            },
          ],
        },
      }));
      return Response.json(Array.isArray(body) ? replies : replies[0]);
    });
    const params = [
      ['11111111111111111111111111111111'],
      { encoding: 'base64', dataSlice: { offset: 0, length: kib * 1024 } },
    ];
    const result = await Promise.all([
      f.reader.programRpc('getMultipleAccounts', params),
      f.reader.programRpc('getMultipleAccounts', params),
    ]);
    expect(f.fetcher).toHaveBeenCalledTimes(kib === 360 ? 1 : 2);
    expect((result[0] as { context: { slot: string } }).context.slot).toBe(
      '100',
    );
  },
);
it('refuses a whole code envelope whose actual raw bytes exceed misleading size hints', async () => {
  const f = fixture(),
    keys = ['11111111111111111111111111111111'];
  f.fetcher.mockImplementationOnce(async (_url, init) => {
    const m = JSON.parse(requestBody(init)) as Message;
    return Response.json({
      jsonrpc: '2.0',
      id: m.id,
      result: { value: [{ space: 1 }] },
    });
  });
  await f.reader.programRpc('getMultipleAccounts', [
    keys,
    { encoding: 'base64', dataSlice: { offset: 0, length: 45 } },
  ]);
  f.fetcher.mockImplementation(async (_url, init) => {
    const messages = JSON.parse(requestBody(init)) as Message[];
    return Response.json(
      messages.map((m) => ({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          value: [
            {
              space: 600 * 1024,
              data: [Buffer.alloc(600 * 1024).toString('base64'), 'base64'],
            },
          ],
        },
      })),
    );
  });
  const params = [
    keys,
    { encoding: 'base64', dataSlice: { offset: 0, length: 720 * 1024 } },
  ];
  const results = await Promise.allSettled([
    f.reader.programRpc('getMultipleAccounts', params),
    f.reader.programRpc('getMultipleAccounts', params),
  ]);
  expect(results.every((x) => x.status === 'rejected')).toBe(true);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it.each(['sendTransaction', 'sendBundle', 'requestAirdrop'])(
  'refuses write method %s before HTTP',
  async (method) => {
    const f = fixture();
    await expect(f.reader.rpc(method, [])).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it.each([
  { sigVerify: true, replaceRecentBlockhash: false },
  { sigVerify: false, replaceRecentBlockhash: true },
  {},
])('refuses changed simulation policy %j before HTTP', async (config) => {
  const f = fixture();
  await expect(
    f.reader.rpc('simulateTransaction', ['packet', config]),
  ).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([false, true])(
  'freshly rechecks code through the owned runtime pipeline, changed=%s',
  async (changed) => {
    const f = await pairRuntimeFixture();
    let after = false,
      beforeReads = 0,
      afterReads = 0,
      wireCalls = 0,
      logicalCalls = 0;
    const large = [...f.programs.values()][0],
      bytes = Buffer.alloc(3 * 1024 * 1024);
    bytes.set([127, 69, 76, 70]);
    large.data[0] = bytes.toString('base64');
    large.space = String(bytes.length);
    f.runtimeState.onTrace = (trace) => {
      after = true;
      if (changed) {
        const program = [...f.programs.values()][0],
          bytes = Buffer.from(program.data[0], 'base64');
        bytes[100] ^= 1;
        program.data[0] = bytes.toString('base64');
      }
      return trace;
    };
    f.runtimeState.onCodeRead = () => {
      if (after) afterReads++;
      else beforeReads++;
    };
    const fetcher: typeof fetch = async (_url, init) => {
      wireCalls++;
      const body = JSON.parse(requestBody(init)),
        messages = (Array.isArray(body) ? body : [body]) as Message[];
      logicalCalls += messages.length;
      const values = await Promise.all(
        messages.map(async (m) => {
          const slice = (m.params[1] as { dataSlice?: { length: number } })
            ?.dataSlice;
          const code =
            m.method === 'getMultipleAccounts' && slice && slice.length !== 166;
          return {
            jsonrpc: '2.0',
            id: m.id,
            result: await (
              code
                ? f.runtimeDependencies.programRpc!
                : f.runtimeDependencies.rpc
            )(m.method, m.params),
          };
        }),
      );
      return Response.json(Array.isArray(body) ? values : values[0]);
    };
    const control = new AbortController(),
      reader = createPairReadRpc(endpoint, control.signal, fetcher);
    pending.push(reader);
    try {
      const work = previewOwnedImportedPairRuntime(
        f.db,
        'alice',
        f.runtimeRequest,
        control.signal,
        {
          ...f.runtimeDependencies,
          rpc: reader.rpc,
          programRpc: reader.programRpc,
        },
      );
      if (changed) await expect(work).rejects.toMatchObject({ status: 409 });
      else
        expect(await work).toMatchObject({
          signingAllowed: false,
          executionAllowed: false,
          runtime: { codeIdentityObserved: true, programCodeAttested: false },
        });
      expect(beforeReads).toBeGreaterThan(0);
      expect(afterReads).toBeGreaterThan(0);
      expect(
        f.rpc.mock.calls.filter(([m]) => m === 'simulateTransaction'),
      ).toHaveLength(1);
      expect(wireCalls).toBeGreaterThan(0);
      expect(wireCalls).toBeLessThan(logicalCalls);
    } finally {
      reader.close();
      f.close();
    }
  },
);
it('fails closed when stale length hints underestimate a later mixed response', async () => {
  const f = fixture(),
    key = '11111111111111111111111111111111';
  f.fetcher.mockImplementationOnce(async (_url, init) => {
    const m = JSON.parse(requestBody(init)) as Message;
    return Response.json({
      jsonrpc: '2.0',
      id: m.id,
      result: { value: [{ space: 1 }] },
    });
  });
  await f.reader.programRpc('getMultipleAccounts', [
    [key],
    { encoding: 'base64', dataSlice: { offset: 0, length: 45 } },
  ]);
  f.fetcher.mockResolvedValue(new Response(' '.repeat(524289)));
  const results = await Promise.allSettled([
    f.reader.programRpc('getMultipleAccounts', [
      [key],
      { encoding: 'base64', dataSlice: { offset: 0, length: 720 * 1024 } },
    ]),
    f.reader.rpc('getGenesisHash', []),
  ]);

  expect(f.fetcher).toHaveBeenCalledTimes(2);
  const body = JSON.parse(requestBody(f.fetcher.mock.calls[1][1]));
  expect(body).toHaveLength(2);
  expect(results.every((x) => x.status === 'rejected')).toBe(true);
});
it('cancels code responses above the unchanged 2-MiB bound', async () => {
  const f = fixture(),
    cancel = vi.fn();
  f.fetcher.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(2097153).fill(32));
        },
        cancel,
      }),
    ),
  );
  await expect(
    f.reader.programRpc('getMultipleAccounts', [
      ['11111111111111111111111111111111'],
      { encoding: 'base64', dataSlice: { offset: 0, length: 720 * 1024 } },
    ]),
  ).rejects.toThrow('Pair RPC batch read failed.');
  expect(cancel).toHaveBeenCalled();
  expect(f.fetcher).toHaveBeenCalledOnce();
});
