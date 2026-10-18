import { expect, it, vi } from 'vitest';
import { readExactExchangeQuoteResponse } from './exchange-quote-response';
import { exchangeUiRequest } from './exchange-ui-request';

const read = (text: string) =>
  readExactExchangeQuoteResponse(
    new Response(text),
    new AbortController().signal,
  );
it('preserves numeric source tokens and strings exactly', async () => {
  expect(
    await read(
      '{"fromAmount":12345678.000000009,"toAmount":12345678.000000001}',
    ),
  ).toEqual({
    fromAmount: '12345678.000000009',
    toAmount: '12345678.000000001',
  });
  expect(await read('{"fromAmount":"1.000000001","toAmount":1}')).toEqual({
    fromAmount: '1.000000001',
    toAmount: '1',
  });
});
it.each(['1e3', '-1', '1.0000000001', '10000000000', '1e400'])(
  'refuses unqualified numeric token %s',
  async (value) => {
    await expect(read('{"fromAmount":' + value + '}')).rejects.toThrow(
      'inexact quote',
    );
  },
);
it('refuses oversized, invalid UTF8 and malformed responses without printing content', async () => {
  for (const response of [
    new Response('x'.repeat(65537)),
    new Response(new Uint8Array([255])),
    new Response('<html>private data</html>'),
  ]) {
    const result = readExactExchangeQuoteResponse(
      response,
      new AbortController().signal,
    );
    await expect(result).rejects.toThrow('unreadable');
    await expect(result).rejects.not.toThrow('private data');
  }
});
it('cancels a hanging body at the complete-request deadline and cleans up its timer', async () => {
  vi.useFakeTimers();
  try {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    );
    const result = exchangeUiRequest(
      new AbortController().signal,
      (signal) => readExactExchangeQuoteResponse(response, signal),
      15000,
    );
    const rejected = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('refuses a late body chunk even when its reader ignores cancellation', async () => {
  vi.useFakeTimers();
  try {
    let release!: (part: ReadableStreamReadResult<Uint8Array>) => void;
    const pending = new Promise<ReadableStreamReadResult<Uint8Array>>(
      (resolve) => {
        release = resolve;
      },
    );
    const cancel = vi.fn().mockResolvedValue(undefined),
      releaseLock = vi.fn();
    const response = {
      headers: new Headers(),
      body: { getReader: () => ({ read: () => pending, cancel, releaseLock }) },
    } as unknown as Response;
    const result = exchangeUiRequest(
      new AbortController().signal,
      (signal) => readExactExchangeQuoteResponse(response, signal),
      15000,
    );
    const rejected = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(cancel).toHaveBeenCalled();
    release({
      done: false,
      value: new TextEncoder().encode('{"fromAmount":1}'),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
