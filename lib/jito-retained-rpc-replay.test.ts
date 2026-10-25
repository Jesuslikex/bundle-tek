import { afterEach, expect, it, vi } from 'vitest';
import {
  createJitoRetainedRpcReplay,
  isJitoRetainedRpcReplay,
} from './jito-retained-rpc-replay';
import { balanceRpc } from './wallet-balances';
import { paceWalletRpc } from './wallet-rpc-pacing';

vi.mock('./wallet-rpc-pacing', () => ({ paceWalletRpc: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const endpoint = 'https://retained.example/private';
const signal = () => new AbortController().signal;
const record = (method = 'getBlockHeight', params: unknown[] = []) => ({
  requestBody: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  rawBody: new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":42}'),
});
const init = (
  read: ReturnType<typeof record>,
  s: AbortSignal,
): RequestInit => ({
  method: 'POST',
  signal: s,
  body: read.requestBody,
});
it('omits pacing only for the exact closed retained transport and still uses the original response parser', async () => {
  const s = signal(),
    read = record();
  const replay = createJitoRetainedRpcReplay(endpoint, [read], s);
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(Error('no network'));
  try {
    expect(isJitoRetainedRpcReplay(replay.fetcher)).toBe(true);
    expect(Object.isFrozen(replay.fetcher)).toBe(true);
    expect(
      await balanceRpc(endpoint, 'getBlockHeight', [], s, replay.fetcher),
    ).toBe('42');
    replay.assertComplete();
    expect(paceWalletRpc).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
});
it('does not enroll a forwarding wrapper, proxy or lookalike in the offline capability', async () => {
  const s = signal(),
    read = record();
  const replay = createJitoRetainedRpcReplay(endpoint, [read], s);
  const forwarded: typeof fetch = (...args) => replay.fetcher(...args);
  expect(isJitoRetainedRpcReplay(forwarded)).toBe(false);
  expect(isJitoRetainedRpcReplay(new Proxy(replay.fetcher, {}))).toBe(false);
  expect(
    isJitoRetainedRpcReplay(
      Object.assign(vi.fn(), { retained: true }) as typeof fetch,
    ),
  ).toBe(false);
  expect(await balanceRpc(endpoint, 'getBlockHeight', [], s, forwarded)).toBe(
    '42',
  );
  expect(paceWalletRpc).toHaveBeenCalledExactlyOnceWith(endpoint, s);
});
it('keeps normal provider calls paced and has no caller-controlled skip flag', async () => {
  const s = signal(),
    provider = vi.fn(async () => new Response(record().rawBody));
  await balanceRpc(endpoint, 'getBlockHeight', [], s, provider as typeof fetch);
  expect(paceWalletRpc).toHaveBeenCalledExactlyOnceWith(endpoint, s);
  expect(provider).toHaveBeenCalledTimes(1);
});
it('owns detached bytes and request order, and returns detached response bodies', async () => {
  const s = signal(),
    first = record(),
    second = record('getGenesisHash');
  const replay = createJitoRetainedRpcReplay(endpoint, [first, second], s);
  first.rawBody.fill(0);
  const response = await replay.fetcher(endpoint, init(record(), s));
  expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: 42 });
  second.requestBody = 'changed outside';
  await replay.fetcher(endpoint, init(record('getGenesisHash'), s));
  replay.assertComplete();
  await expect(replay.fetcher(endpoint, init(record(), s))).rejects.toThrow();
});
for (const mutation of ['target', 'method', 'signal', 'body'] as const)
  it(`refuses changed ${mutation} permanently without a network fallback`, async () => {
    const s = signal(),
      read = record(),
      replay = createJitoRetainedRpcReplay(endpoint, [read], s);
    const request = init(read, s);
    if (mutation === 'method') request.method = 'GET';
    if (mutation === 'signal') request.signal = signal();
    if (mutation === 'body')
      request.body = record('getGenesisHash').requestBody;
    await expect(
      replay.fetcher(
        mutation === 'target' ? endpoint + '/other' : endpoint,
        request,
      ),
    ).rejects.toThrow();
    await expect(replay.fetcher(endpoint, init(read, s))).rejects.toThrow();
    expect(() => replay.assertComplete()).toThrow();
  });
it('refuses missing, extra and repeated reads', async () => {
  const s = signal(),
    read = record();
  const incomplete = createJitoRetainedRpcReplay(endpoint, [read, read], s);
  await incomplete.fetcher(endpoint, init(read, s));
  expect(() => incomplete.assertComplete()).toThrow();
  const extra = createJitoRetainedRpcReplay(endpoint, [read], s);
  await extra.fetcher(endpoint, init(read, s));
  await expect(extra.fetcher(endpoint, init(read, s))).rejects.toThrow();
  expect(() => extra.assertComplete()).toThrow();
});
it('checks abort before factory creation, each read and completion', async () => {
  const c = new AbortController(),
    read = record();
  const replay = createJitoRetainedRpcReplay(endpoint, [read], c.signal);
  c.abort();
  expect(() =>
    createJitoRetainedRpcReplay(endpoint, [read], c.signal),
  ).toThrow();
  await expect(
    replay.fetcher(endpoint, init(read, c.signal)),
  ).rejects.toThrow();
  expect(() => replay.assertComplete()).toThrow();
});
for (const raw of [
  '{"jsonrpc":"2.0","id":2,"result":42}',
  '{"jsonrpc":"2.0","id":1,"error":{"code":429}}',
  '<html>error</html>',
])
  it(`preserves original envelope/parser refusal: ${raw}`, async () => {
    const s = signal(),
      read = { ...record(), rawBody: new TextEncoder().encode(raw) };
    const replay = createJitoRetainedRpcReplay(endpoint, [read], s);
    await expect(
      balanceRpc(endpoint, 'getBlockHeight', [], s, replay.fetcher),
    ).rejects.toThrow();
    expect(paceWalletRpc).not.toHaveBeenCalled();
  });
it('keeps the original maximum response bound', async () => {
  const s = signal(),
    replay = createJitoRetainedRpcReplay(endpoint, [record()], s);
  await expect(
    balanceRpc(endpoint, 'getBlockHeight', [], s, replay.fetcher, 10),
  ).rejects.toThrow('too large');
});
it('rejects sparse, oversized and accessor source records without invoking getters', () => {
  const s = signal(),
    getter = vi.fn(() => record().requestBody);
  const accessor = {
    get requestBody() {
      return getter();
    },
    rawBody: record().rawBody,
  };
  const sparse = [record()];
  Reflect.deleteProperty(sparse, '0');
  for (const reads of [
    [],
    sparse,
    [accessor],
    Array.from({ length: 33 }, () => record()),
    [{ ...record(), rawBody: new Uint8Array(524289) }],
    [{ ...record(), requestBody: 'x'.repeat(32769) }],
  ])
    expect(() => createJitoRetainedRpcReplay(endpoint, reads, s)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it('refuses proxy byte-length spoofing and ignores a real array custom iterator', async () => {
  const s = signal();
  const proxy = new Proxy(new Uint8Array(600000), {
    get(target, key) {
      if (key === 'byteLength') return 1;
      if (key === Symbol.iterator)
        return function* () {
          yield 42;
        };
      return Reflect.get(target, key);
    },
  });
  expect(() =>
    createJitoRetainedRpcReplay(endpoint, [{ ...record(), rawBody: proxy }], s),
  ).toThrow();
  const bytes = record().rawBody;
  Object.defineProperty(bytes, 'byteLength', { value: 1 });
  const iterator = vi.fn(function* () {
    yield 42;
  });
  Object.defineProperty(bytes, Symbol.iterator, { value: iterator });
  const replay = createJitoRetainedRpcReplay(
    endpoint,
    [{ ...record(), rawBody: bytes }],
    s,
  );
  expect(
    await (await replay.fetcher(endpoint, init(record(), s))).json(),
  ).toEqual({ jsonrpc: '2.0', id: 1, result: 42 });
  replay.assertComplete();
  expect(iterator).not.toHaveBeenCalled();
});
