import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { readJitoRpcBatchCapture } from './jito-rpc-batch-capture';

const ids = ['fee:0', 'sim:0'];
const a = '{"jsonrpc":"2.0","id":"fee:0","result":18446744073709551615}';
const b =
  '{"id":"sim:0","result":{"uiAmount":1.23456789e-7,"text":"雪😀 \\\" } ] { \\\\ \\u0061","nested":[{},[1]]},"jsonrpc":"2.0"}';
const wire = ` \n[ ${a},\r\n ${b} ]\t`;
const bytes = (s: string) => new TextEncoder().encode(s);
const hash = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
const read = (s: string, expected: readonly string[] = ids) =>
  readJitoRpcBatchCapture(
    new Response(s).body,
    new AbortController().signal,
    expected,
  );
afterEach(() => vi.restoreAllMocks());

it('handles UTF-8 and escape sequences split across single-byte chunks', async () => {
  const input = bytes(wire);
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at === input.length) c.close();
      else c.enqueue(input.slice(at, ++at));
    },
  });
  const r = await readJitoRpcBatchCapture(
    body,
    new AbortController().signal,
    ids,
  );
  expect(r.status).toBe('captured');
  if (r.status === 'captured')
    expect(r.members.map((m) => new TextDecoder().decode(m.rawBody))).toEqual([
      a,
      b,
    ]);
});

it('admits six exact ordered IDs including the 128 character boundary', async () => {
  const expected = ['a'.repeat(128), 'b', 'c', 'd', 'e', 'f'];
  const wire = JSON.stringify(
    expected.map((id) => ({ jsonrpc: '2.0', id, result: null })),
  );
  const r = await read(wire, expected);
  expect(r.status).toBe('captured');
  if (r.status === 'captured')
    expect(r.members.map((m) => m.id)).toEqual(expected);
});

it('rejects invalid UTF-8 rather than returning partial ranges', async () => {
  const body = new Response(new Uint8Array([91, 0xff, 93])).body;
  expect(
    await readJitoRpcBatchCapture(body, new AbortController().signal, ids),
  ).toMatchObject({
    status: 'refused',
    reason: 'response-invalid',
    rawResponse: null,
  });
});

it('retains exact parent/member UTF-8 byte ranges, u64 and opaque decimals', async () => {
  const result = await read(wire);
  expect(result.status).toBe('captured');
  if (result.status !== 'captured') throw Error(result.reason);
  expect(result.rawResponse.rawSha256).toBe(hash(bytes(wire)));
  expect((result.rawResponse.value as { result: unknown }[])[0].result).toBe(
    18446744073709551615n,
  );
  expect(
    result.members.map((m) => new TextDecoder().decode(m.rawBody)),
  ).toEqual([a, b]);
  for (const m of result.members) {
    expect(m.rawBody).toEqual(bytes(wire).slice(m.start, m.end));
    expect(m.sha256).toBe(hash(m.rawBody));
  }
  for (const [k, v] of Object.entries(result))
    if (
      k.endsWith('Allowed') ||
      k.endsWith('Verified') ||
      k.endsWith('Qualified') ||
      k.endsWith('Authenticated')
    )
      expect(v).toBe(false);
});

it('keeps member and parent copies independent after return', async () => {
  const r = await read(wire);
  if (r.status !== 'captured') throw Error(r.reason);
  const first = r.members[0].rawBody.slice();
  r.rawResponse.rawBody.fill(0);
  expect(r.members[0].rawBody).toEqual(first);
  r.members[0].rawBody.fill(1);
  expect(new TextDecoder().decode(r.members[1].rawBody)).toBe(b);
});

it('snapshots IDs before awaiting and copies incoming bytes', async () => {
  const expected = [...ids];
  const input = bytes(wire);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      await gate;
      c.enqueue(input);
      c.close();
    },
  });
  const promise = readJitoRpcBatchCapture(
    stream,
    new AbortController().signal,
    expected,
  );
  expected[0] = 'mutated';
  release();
  const r = await promise;
  expect(r.status).toBe('captured');
  input.fill(0);
  if (r.status === 'captured')
    expect(new TextDecoder().decode(r.members[0].rawBody)).toBe(a);
});

it.each([
  `[{"jsonrpc":"2.0","id":"fee:0","error":{"code":-32602,"message":"bank unavailable"}},${b}]`,
  `[${a},{"jsonrpc":"2.0","id":"sim:0","result":null}]`,
])('captures exclusive result or error without method admission', async (s) =>
  expect((await read(s)).status).toBe('captured'),
);

it.each([
  `[${b},${a}]`,
  `[${a},${a}]`,
  `[${a}]`,
  `[${a},${b},${a}]`,
  `{"result":[${a},${b}]}`,
  `[1,${b}]`,
  `[${a},{"jsonrpc":"2.0","id":"sim:0"}]`,
  `[${a},{"jsonrpc":"2.0","id":"sim:0","result":null,"error":null}]`,
  `[${a},{"jsonrpc":"2.0","id":"sim:0","result":null,"extra":0}]`,
  `[${a},{"jsonrpc":"1.0","id":"sim:0","result":null}]`,
  `[${a},{"jsonrpc":"2.0","id":1,"result":null}]`,
])(
  'refuses differing complete envelopes and retains full parent: %s',
  async (s) => {
    const r = await read(s);
    expect(r.status).toBe('refused');
    if (r.status === 'refused') {
      expect(r.reason).toBe('batch-envelope-invalid');
      expect(r.rawResponse?.rawBody).toEqual(bytes(s));
    }
  },
);

it.each([
  '[',
  `[${a},${b}`,
  `[${a},${b}] trailing`,
  `[${a},{"id":"sim:0","id":"sim:0","jsonrpc":"2.0","result":null}]`,
  '\ufeff' + wire,
])(
  'refuses incomplete/invalid raw JSON without a partial capture',
  async (s) => {
    const r = await read(s);
    expect(r).toMatchObject({
      status: 'refused',
      reason: 'response-invalid',
      rawResponse: null,
    });
  },
);

it.each([
  [],
  ['one'],
  ['a', 'a'],
  ['a', 'bad id'],
  ['a', 'x'.repeat(129)],
  Array(2),
  ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
])(
  'rejects invalid expected IDs without acquiring body: %j',
  async (expected) => {
    const body = new ReadableStream<Uint8Array>();
    const get = vi.spyOn(body, 'getReader');
    await expect(
      readJitoRpcBatchCapture(body, new AbortController().signal, expected),
    ).rejects.toThrow('invalid expected IDs');
    expect(get).not.toHaveBeenCalled();
  },
);

it('refuses ID accessor/extra/symbol/custom-prototype arrays without invoking accessors', async () => {
  const getter = vi.fn(() => 'a');
  const accessor = ['a', 'b'];
  Object.defineProperty(accessor, '0', { get: getter, enumerable: true });
  const extra = ['a', 'b'];
  Object.assign(extra, { extra: true });
  const symbol = ['a', 'b'];
  Object.defineProperty(symbol, Symbol('x'), { value: true });
  const proto = ['a', 'b'];
  Object.setPrototypeOf(proto, {});
  for (const value of [accessor, extra, symbol, proto])
    await expect(read('[]', value)).rejects.toThrow('invalid expected IDs');
  expect(getter).not.toHaveBeenCalled();
});

it('leaves pre-aborted body caller-owned', async () => {
  const c = new AbortController();
  c.abort();
  const body = new ReadableStream<Uint8Array>();
  const get = vi.spyOn(body, 'getReader');
  await expect(readJitoRpcBatchCapture(body, c.signal, ids)).rejects.toThrow(
    'interrupted signal',
  );
  expect(get).not.toHaveBeenCalled();
});

it('cancels a pending read and never retains partial bytes', async () => {
  const c = new AbortController();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const p = readJitoRpcBatchCapture(body, c.signal, ids);
  c.abort();
  expect(await p).toMatchObject({
    status: 'refused',
    reason: 'interrupted',
    rawResponse: null,
  });
  expect(cancel).toHaveBeenCalled();
  expect(body.locked).toBe(false);
});

it('refuses abort during member hashing promptly with full parent capture', async () => {
  const c = new AbortController();
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let calls = 0;
  vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
    if (++calls === 2) {
      queueMicrotask(() => c.abort());
      return new Promise<ArrayBuffer>(() => {});
    }
    return original(algorithm, data);
  });
  const r = await readJitoRpcBatchCapture(
    new Response(wire).body,
    c.signal,
    ids,
  );
  expect(r).toMatchObject({ status: 'refused', reason: 'interrupted' });
  expect(r.rawResponse?.rawBody).toEqual(bytes(wire));
});

it('enforces the 4 MiB byte bound and null-body refusal', async () => {
  expect(await read(' '.repeat(4 * 1024 * 1024 + 1))).toMatchObject({
    status: 'refused',
    reason: 'response-invalid',
    rawResponse: null,
  });
  expect(
    await readJitoRpcBatchCapture(null, new AbortController().signal, ids),
  ).toMatchObject({
    status: 'refused',
    reason: 'response-invalid',
    rawResponse: null,
  });
});
