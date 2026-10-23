import { expect, it, vi } from 'vitest';
import { jitoRpc, getJitoTipAccounts } from './jito-provider';
import { readJitoJson } from './jito-json';
const bytes = (text: string) => new TextEncoder().encode(text);
const signal = () => new AbortController().signal;

it('bounds actual streamed UTF-8 bytes and cancels without reading the remaining body', async () => {
  const cancel = vi.fn();
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        pulls++;
        c.enqueue(bytes('"' + '€'.repeat(12000)));
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const fetcher = vi.fn(async () => new Response(stream));
  await expect(
    jitoRpc('getTipAccounts', [], signal(), fetcher),
  ).rejects.toThrow('byte limit');
  expect(pulls).toBe(1);
  expect(cancel).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledOnce();
});
it('accepts a JSON document exactly at its byte bound including a split UTF-8 character', async () => {
  const payload = bytes('"€"');
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(payload.slice(0, 2));
      c.enqueue(payload.slice(2));
      c.close();
    },
  });
  await expect(readJitoJson(stream, signal(), 5)).resolves.toBe('€');
});
it('aborts a stalled response body and never retries the provider', async () => {
  const controller = new AbortController(),
    cancel = vi.fn();
  const fetcher = vi.fn(
    async () => new Response(new ReadableStream({ cancel })),
  );
  const pending = jitoRpc(
    'sendBundle',
    [[], { encoding: 'base64' }],
    controller.signal,
    fetcher,
  );
  await Promise.resolve();
  controller.abort();
  await expect(pending).rejects.toThrow('interrupted');
  expect(cancel).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledOnce();
});
it('an already aborted request never reaches fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetcher = vi.fn();
  await expect(
    jitoRpc('getTipAccounts', [], controller.signal, fetcher),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
for (const value of [
  null,
  [],
  'bad',
  { jsonrpc: '2.0', id: 2, result: [] },
  { jsonrpc: '2.0', id: 1 },
  { jsonrpc: '2.0', id: 1, result: [], error: { code: -1 } },
])
  it(`refuses malformed or unrelated RPC envelope ${JSON.stringify(value)}`, async () => {
    const fetcher = vi.fn(async () => Response.json(value));
    await expect(
      jitoRpc('getTipAccounts', [], signal(), fetcher),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
for (const status of [302, 429, 503])
  it(`does not retry or read an HTTP ${status} error body`, async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn(
      async () => new Response(new ReadableStream({ cancel }), { status }),
    );
    await expect(
      jitoRpc('getTipAccounts', [], signal(), fetcher),
    ).rejects.toThrow(String(status));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });
it('rejects invalid UTF-8 and duplicate or invalid tip recipients', async () => {
  await expect(
    readJitoJson(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([34, 255, 34]));
          c.close();
        },
      }),
      signal(),
      20,
    ),
  ).rejects.toThrow('unavailable');
  for (const result of [
    [],
    ['invalid'],
    ['11111111111111111111111111111111', '11111111111111111111111111111111'],
  ])
    await expect(
      getJitoTipAccounts(signal(), async () =>
        Response.json({ jsonrpc: '2.0', id: 1, result }),
      ),
    ).rejects.toThrow();
});
