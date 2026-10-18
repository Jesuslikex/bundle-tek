import { afterEach, expect, it, vi } from 'vitest';
import { exchangeUiRequest } from './exchange-ui-request';
afterEach(() => vi.useRealTimers());
it('settles a hung read at its exact deadline and aborts its transport', async () => {
  vi.useFakeTimers();
  let child!: AbortSignal;
  const pending = exchangeUiRequest(
    new AbortController().signal,
    async (signal) => {
      child = signal;
      return new Promise<never>(() => {});
    },
  );
  const refusal = expect(pending).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(29999);
  expect(child.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await refusal;
  expect(child.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it('cancels ignored work immediately and never starts an already cancelled read', async () => {
  const parent = new AbortController();
  const read = vi.fn(async () => new Promise<never>(() => {}));
  const pending = exchangeUiRequest(parent.signal, read);
  parent.abort();
  await expect(pending).rejects.toThrow();
  await expect(exchangeUiRequest(parent.signal, read)).rejects.toThrow();
  expect(read).toHaveBeenCalledTimes(1);
});
it('cleans the deadline and listeners after success or failure', async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  let signal!: AbortSignal;
  expect(
    await exchangeUiRequest(parent.signal, async (child) => {
      signal = child;
      return 7;
    }),
  ).toBe(7);
  expect(signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await expect(
    exchangeUiRequest(parent.signal, async () => {
      throw new Error('refused');
    }),
  ).rejects.toThrow('refused');
  expect(vi.getTimerCount()).toBe(0);
});
