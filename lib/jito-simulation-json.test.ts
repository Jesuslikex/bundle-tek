import { expect, it, vi } from 'vitest';
import { readJitoSimulationJson } from './jito-simulation-json';
const encoder = new TextEncoder();
function body(text: string, chunkSize = 9999999) {
  const bytes = encoder.encode(text);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (at === bytes.length) {
        c.close();
        return;
      }
      c.enqueue(bytes.slice(at, at + chunkSize));
      at = Math.min(at + chunkSize, bytes.length);
    },
  });
}
const read = (text: string, limit?: number) =>
  readJitoSimulationJson(body(text), new AbortController().signal, limit);
it('preserves canonical signed integers losslessly including u64 max and RPC negative codes', async () => {
  const value = (await read(
    '{"jsonrpc":"2.0","id":1,"result":{"slot":9007199254740993,"lamports":18446744073709551615,"zero":0},"error":{"code":-32000}}',
  )) as Record<string, unknown>;
  expect(value).toEqual({
    jsonrpc: '2.0',
    id: 1n,
    result: {
      slot: 9007199254740993n,
      lamports: 18446744073709551615n,
      zero: 0n,
    },
    error: { code: -32000n },
  });
  expect(Object.getPrototypeOf(value)).toBeNull();
  expect(Object.getPrototypeOf(value.result)).toBeNull();
});
it('parses nested JSON and strings with every escape and paired Unicode across one-byte chunks', async () => {
  const text =
    ' {"a":[true,false,null,{},[],"€🙂","\\\"\\\\\\/\\b\\f\\n\\r\\t","\\uD83D\\uDE42"]}\n';
  const value = (await readJitoSimulationJson(
    body(text, 1),
    new AbortController().signal,
  )) as { a: unknown[] };
  expect(value.a).toEqual([
    true,
    false,
    null,
    {},
    [],
    '€🙂',
    '"\\/\b\f\n\r\t',
    '🙂',
  ]);
});
it('matches valid nonnumeric JSON reference values without imposing Unicode normalization', async () => {
  for (const v of [
    null,
    true,
    false,
    'x\ny',
    { a: [true, 'a\\b', { b: 'é', c: 'é' }] },
    ['\u0000', '\u2028', '🙂'],
  ])
    expect(await read(JSON.stringify(v))).toEqual(v);
});
for (const token of [
  '-0',
  '0.0',
  '1.0',
  '1.5',
  '1e3',
  '1E+3',
  '1e-400',
  '9007199254740991.1',
  '18446744073709551615.0',
  '+1',
  '01',
  '-01',
  'NaN',
  'Infinity',
  '--1',
])
  it(`refuses noncanonical or rounded numeric token ${token}`, async () => {
    await expect(read('{"fee":' + token + '}')).rejects.toThrow();
  });
for (const text of [
  '{"a":1,"a":2}',
  '{"a":1,"\\u0061":2}',
  '{"\\uD83D\\uDE42":1,"🙂":2}',
  '{"a":{"b":true,"\\u0062":false}}',
])
  it(`refuses duplicate decoded keys ${text}`, async () =>
    expect(read(text)).rejects.toThrow('duplicate object key'));
it('allows a key reused in separate objects and stores __proto__ safely as ordinary own data', async () => {
  const text =
    '{"__proto__":{"polluted":true},"constructor":"data","a":{"x":1},"b":{"x":2}}';
  const value = (await read(text)) as Record<string, unknown>;
  expect(Object.getPrototypeOf(value)).toBeNull();
  expect(Object.hasOwn(value, '__proto__')).toBe(true);
  expect(value.__proto__).toEqual({ polluted: true });
  expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  expect(value.a).toEqual({ x: 1n });
  expect(value.b).toEqual({ x: 2n });
});
for (const text of [
  '',
  ' ',
  '[1,]',
  '{"a":}',
  '{a:1}',
  '{"a" 1}',
  '[true false]',
  'true false',
  'nullx',
  '"unterminated',
  '"\\x20"',
  '"\\u123"',
  '"\\uD800"',
  '"\\uDC00"',
  '"\\uD800a"',
  '"line\nfeed"',
  '\uFEFF{}',
])
  it(`refuses invalid grammar or unpaired Unicode ${JSON.stringify(text)}`, async () =>
    expect(read(text)).rejects.toThrow());
it('allows exactly 32 nested containers and refuses the next nesting level', async () => {
  expect(await read('['.repeat(32) + 'null' + ']'.repeat(32))).toBeDefined();
  await expect(read('['.repeat(33) + 'null' + ']'.repeat(33))).rejects.toThrow(
    'depth bound',
  );
});
it('allows exactly 4096 array/object members and refuses retaining the next value', async () => {
  expect(
    await read('[' + Array.from({ length: 4096 }, () => 0).join(',') + ']'),
  ).toHaveLength(4096);
  await expect(
    read('[' + Array.from({ length: 4097 }, () => 0).join(',') + ']'),
  ).rejects.toThrow('container member bound');
  const fields = Array.from({ length: 4096 }, (_, i) => '"k' + i + '":null');
  expect(
    Object.keys((await read('{' + fields.join(',') + '}')) as object),
  ).toHaveLength(4096);
  await expect(
    read('{' + [...fields, '"last":null'].join(',') + '}'),
  ).rejects.toThrow('container member bound');
});
it('enforces the total node bound independently of container width/depth', async () => {
  const groups = Array.from({ length: 25 }, () =>
    Array.from({ length: 3999 }, () => null),
  );
  groups[24].pop(); // Root + 25 groups + 99974 leaves = exactly 100000 value nodes.
  expect(await read(JSON.stringify(groups))).toHaveLength(25);
  groups[24].push(null);
  await expect(read(JSON.stringify(groups))).rejects.toThrow('node bound');
});
it('counts actual UTF-8 bytes at the bound, including multibyte characters', async () => {
  const text = '"€🙂"',
    size = encoder.encode(text).length;
  expect(
    await readJitoSimulationJson(
      body(text, 1),
      new AbortController().signal,
      size,
    ),
  ).toBe('€🙂');
  await expect(read(text, size - 1)).rejects.toThrow('byte bound');
});
it('accepts the hard 4 MiB boundary and refuses one excess streamed byte', async () => {
  const max = 4194304,
    text = '"' + 'x'.repeat(max - 2) + '"';
  expect(((await read(text)) as string).length).toBe(max - 2);
  await expect(read(text + ' ')).rejects.toThrow('byte bound');
});
for (const limit of [0, -1, 4194305, Infinity, NaN, 1.5])
  it(`refuses invalid configured limit ${limit} before taking a reader`, async () => {
    const stream = body('{}');
    await expect(
      readJitoSimulationJson(stream, new AbortController().signal, limit),
    ).rejects.toThrow('invalid byte bound');
    expect(stream.locked).toBe(false);
  });
it('rejects missing bodies and aborts before taking a lock', async () => {
  await expect(
    readJitoSimulationJson(null, new AbortController().signal),
  ).rejects.toThrow('missing body');
  const controller = new AbortController();
  controller.abort();
  const stream = body('{}');
  await expect(
    readJitoSimulationJson(stream, controller.signal),
  ).rejects.toThrow('interrupted');
  expect(stream.locked).toBe(false);
});
it('refuses malformed or truncated UTF-8 and releases the reader', async () => {
  for (const bytes of [
    new Uint8Array([34, 0xc3, 34]),
    new Uint8Array([34, 0xe2, 0x82]),
    new Uint8Array([34, 0xed, 0xa0, 0x80, 34]),
  ]) {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
    await expect(
      readJitoSimulationJson(stream, new AbortController().signal),
    ).rejects.toThrow('invalid UTF-8');
    expect(stream.locked).toBe(false);
  }
});
it('cancels immediately at a byte overflow without draining pending content', async () => {
  const cancel = vi.fn(),
    pull = vi.fn((c: ReadableStreamDefaultController<Uint8Array>) =>
      c.enqueue(encoder.encode('"' + 'x'.repeat(20))),
    );
  const stream = new ReadableStream<Uint8Array>(
    { pull, cancel },
    { highWaterMark: 0 },
  );
  await expect(
    readJitoSimulationJson(stream, new AbortController().signal, 10),
  ).rejects.toThrow('byte bound');
  expect(pull).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
  expect(stream.locked).toBe(false);
});
it('aborts promptly during a pending read even when underlying cancellation never settles', async () => {
  const controller = new AbortController(),
    cancel = vi.fn(() => new Promise<void>(() => {}));
  const stream = new ReadableStream<Uint8Array>(
    {
      pull() {
        return new Promise<void>(() => {});
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const promise = readJitoSimulationJson(stream, controller.signal);
  await Promise.resolve();
  controller.abort();
  await expect(promise).rejects.toThrow('interrupted');
  expect(cancel).toHaveBeenCalledOnce();
  expect(stream.locked).toBe(false);
});
it('removes abort listeners after success and releases locks after stream errors', async () => {
  const controller = new AbortController(),
    remove = vi.spyOn(EventTarget.prototype, 'removeEventListener');
  const stream = body('{}');
  await readJitoSimulationJson(stream, controller.signal);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  remove.mockRestore();
  expect(stream.locked).toBe(false);
  const failed = new ReadableStream<Uint8Array>({
    pull(c) {
      c.error(Error('synthetic stream failure'));
    },
  });
  await expect(
    readJitoSimulationJson(failed, new AbortController().signal),
  ).rejects.toThrow();
  expect(failed.locked).toBe(false);
});

it('does not interpret structural spellings within strings or invoke a toJSON property', async () => {
  const value = (await read(
    '{"toJSON":"data","text":"{\\"a\\":1,\\"a\\":2}","number":"1e99"}',
  )) as Record<string, unknown>;
  expect(value.toJSON).toBe('data');
  expect(value.number).toBe('1e99');
});
it('rejects non-byte chunks and releases its reader', async () => {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue('not bytes');
    },
  }) as unknown as ReadableStream<Uint8Array>;
  await expect(
    readJitoSimulationJson(stream, new AbortController().signal),
  ).rejects.toThrow('non-byte body');
  expect(stream.locked).toBe(false);
});

it('sanitizes arbitrary stream failures without exposing private-style provider text', async () => {
  const secret =
    'https://private.example.invalid/rpc?api_key=FAKE_PRIVATE_TEST_VALUE';
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      c.error(Error(secret));
    },
  });
  let error: unknown;
  try {
    await readJitoSimulationJson(stream, new AbortController().signal);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    'Jito simulation JSON: stream unavailable.',
  );
  expect((error as Error).message).not.toContain(secret);
  expect(stream.locked).toBe(false);
});
it('reads many one-byte chunks and does not turn numeric-looking string values into numbers', async () => {
  const original = '\\'.repeat(16384) + '9007199254740991.1';
  const stream = body(JSON.stringify(original), 1);
  expect(
    await readJitoSimulationJson(stream, new AbortController().signal),
  ).toBe(original);
  expect(stream.locked).toBe(false);
});

it('bounds empty-chunk loops that consume no byte budget and can starve timeout callbacks', async () => {
  let pulls = 0;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        if (pulls === 1) controller.enqueue(encoder.encode('{}'));
        else if (pulls <= 100002) controller.enqueue(new Uint8Array());
        else controller.close();
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  await expect(
    readJitoSimulationJson(stream, new AbortController().signal, 2),
  ).rejects.toThrow('chunk bound');
  expect(pulls).toBe(100001);
  expect(cancel).toHaveBeenCalledOnce();
  expect(stream.locked).toBe(false);
});

it('allows the chunk boundary with empty chunks while retaining exact bytes', async () => {
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        if (pulls === 1) controller.enqueue(encoder.encode('{}'));
        else if (pulls <= 100000) controller.enqueue(new Uint8Array());
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  await expect(
    readJitoSimulationJson(stream, new AbortController().signal, 2),
  ).resolves.toEqual({});
  expect(pulls).toBe(100001);
  expect(stream.locked).toBe(false);
});

for (const subclass of [false, true])
  it(`measures actual byte length when a ${subclass ? 'subclass' : 'chunk'} spoofs its length`, async () => {
    class ShortChunk extends Uint8Array {
      get byteLength() {
        return 0;
      }
    }
    const bytes = subclass
      ? new ShortChunk(encoder.encode('null'))
      : encoder.encode('null');
    if (!subclass) Object.defineProperty(bytes, 'byteLength', { value: 0 });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
    await expect(
      readJitoSimulationJson(stream, new AbortController().signal, 3),
    ).rejects.toThrow('byte bound');
    expect(stream.locked).toBe(false);
  });

it('refuses shared mutable byte backing instead of admitting a moving buffer', async () => {
  const bytes = new Uint8Array(new SharedArrayBuffer(4));
  bytes.set(encoder.encode('null'));
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
  await expect(
    readJitoSimulationJson(stream, new AbortController().signal),
  ).rejects.toThrow('non-private byte body');
  expect(stream.locked).toBe(false);
});

it('does not trust a forged parser error constructor or a mutated genuine error message', async () => {
  let original!: Error;
  try {
    await readJitoSimulationJson(null, new AbortController().signal, 0);
  } catch (error) {
    original = error as Error;
  }
  const secret = 'FAKE_PRIVATE_PROVIDER_TEXT';
  const Constructor = original.constructor as new (message: string) => Error;
  const forged = new Constructor(secret);
  original.message = secret;
  for (const [error, expected] of [
    [forged, 'stream unavailable'],
    [original, 'invalid byte bound'],
  ] as const) {
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(error);
      },
    });
    let refusal!: Error;
    try {
      await readJitoSimulationJson(stream, new AbortController().signal);
    } catch (error) {
      refusal = error as Error;
    }
    expect(refusal.message).toContain(expected);
    expect(refusal.message).not.toContain(secret);
    expect(stream.locked).toBe(false);
  }
});

it('keeps numeric versus quoted id, owner and data tokens distinguishable', async () => {
  const v = (await read(
    '{"id":1,"quotedId":"1","owner":11111111111111111111,"quotedOwner":"11111111111111111111","data":12345678901234567890,"quotedData":"12345678901234567890"}',
  )) as Record<string, unknown>;
  expect(v.id).toBe(1n);
  expect(v.quotedId).toBe('1');
  expect(v.owner).toBe(11111111111111111111n);
  expect(v.quotedOwner).toBe('11111111111111111111');
  expect(v.data).toBe(12345678901234567890n);
  expect(v.quotedData).toBe('12345678901234567890');
});
for (const token of [
  '100000000000000000000',
  '-100000000000000000000',
  '1'.repeat(4096),
])
  it(`refuses more than twenty numeric digits before BigInt conversion length ${token.length}`, async () =>
    expect(read(token)).rejects.toThrow('integer digit bound'));
it('admits the 20-digit signed lexical boundary without claiming field-specific u64 range', async () => {
  expect(await read('99999999999999999999')).toBe(99999999999999999999n);
  expect(await read('-99999999999999999999')).toBe(-99999999999999999999n);
});
it('requires a native AbortSignal before acquiring any reader', async () => {
  for (const fake of [
    { aborted: false },
    Object.create(AbortSignal.prototype),
    null,
  ]) {
    const stream = body('{}');
    await expect(
      readJitoSimulationJson(stream, fake as AbortSignal),
    ).rejects.toThrow('invalid abort signal');
    expect(stream.locked).toBe(false);
  }
});
it('preserves an externally locked reader and sanitizes its acquisition failure', async () => {
  const stream = body('{}'),
    external = stream.getReader();
  await expect(
    readJitoSimulationJson(stream, new AbortController().signal),
  ).rejects.toThrow('reader unavailable');
  expect(stream.locked).toBe(true);
  expect((await external.read()).value).toEqual(encoder.encode('{}'));
  external.releaseLock();
});
it('never exposes a private-style abort reason, including before the first read', async () => {
  const reason = Error(
    'https://private.example.invalid/?key=FAKE_ABORT_SECRET',
  );
  for (const before of [true, false]) {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
    });
    if (before) controller.abort(reason);
    const promise = readJitoSimulationJson(stream, controller.signal);
    if (!before) controller.abort(reason);
    await expect(promise).rejects.toThrow('Jito simulation JSON: interrupted.');
    expect(stream.locked).toBe(false);
  }
});
it('refuses a UTF-8 BOM split across byte chunks and accepts empty chunks around valid data', async () => {
  await expect(
    readJitoSimulationJson(body('\uFEFF{}', 1), new AbortController().signal),
  ).rejects.toThrow();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array());
      c.enqueue(encoder.encode('[0]'));
      c.enqueue(new Uint8Array());
      c.close();
    },
  });
  expect(
    await readJitoSimulationJson(stream, new AbortController().signal),
  ).toEqual([0n]);
});
it('sanitizes cleanup failures without replacing a successful parsed result', async () => {
  const stream = body('{"a":1}'),
    original = stream.getReader.bind(stream);
  vi.spyOn(stream, 'getReader').mockImplementation(() => {
    const reader = original();
    const release = reader.releaseLock.bind(reader);
    reader.releaseLock = () => {
      release();
      throw Error('https://private.example.invalid/?key=FAKE_RELEASE_SECRET');
    };
    return reader;
  });
  expect(
    await readJitoSimulationJson(stream, new AbortController().signal),
  ).toEqual({ a: 1n });
  expect(stream.locked).toBe(false);
});

it('uses native signal state without invoking a caller-defined aborted getter', async () => {
  const signal = new AbortController().signal,
    getter = vi.fn(() => {
      throw Error('https://private.invalid/?key=FAKE_GETTER_SECRET');
    });
  Object.defineProperty(signal, 'aborted', { get: getter });
  expect(await readJitoSimulationJson(body('{}'), signal)).toEqual({});
  expect(getter).not.toHaveBeenCalled();
});
