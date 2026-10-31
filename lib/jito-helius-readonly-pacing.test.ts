import { afterEach, expect, it, vi } from 'vitest';
import { createJitoHeliusReadonlyPacer } from './jito-helius-readonly-pacing';
import { paceWalletRpc } from './wallet-rpc-pacing';
vi.mock('./wallet-rpc-pacing', () => ({
  paceWalletRpc: vi.fn(async () => {}),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
it('counts all five batch methods, preserves the weighted gap, and waits before the ninth', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const signal = new AbortController().signal,
    p = createJitoHeliusReadonlyPacer(
      'https://mainnet.helius-rpc.com/',
      signal,
    );
  await p(5);
  let middle = false;
  const three = p(3).then(() => {
    middle = true;
  });
  await vi.advanceTimersByTimeAsync(749);
  expect(middle).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await three;
  let done = false;
  const pending = p(1).then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(499);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(done).toBe(true);
  expect(vi.mocked(paceWalletRpc).mock.calls).toHaveLength(9);
  expect(
    vi
      .mocked(paceWalletRpc)
      .mock.calls.every((c) => c[2] === 1 && c[1] === signal),
  ).toBe(true);
});
it('serializes concurrent batches without a burst above nine methods', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const p = createJitoHeliusReadonlyPacer(
      'https://mainnet.helius-rpc.com/',
      new AbortController().signal,
    ),
    times: number[] = [];
  const all = Promise.all([
    p(5).then(() => times.push(Date.now())),
    p(5).then(() => times.push(Date.now())),
  ]);
  await vi.advanceTimersByTimeAsync(1250);
  await all;
  expect(times).toEqual([10000, 11250]);
});
it('cancels queued admissions and refuses oversized counts or another endpoint', async () => {
  vi.useFakeTimers();
  const c = new AbortController(),
    p = createJitoHeliusReadonlyPacer(
      'https://mainnet.helius-rpc.com/',
      c.signal,
    );
  await p(5);
  const three = p(3);
  await vi.advanceTimersByTimeAsync(750);
  await three;
  const pending = p(1);
  const assertion = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0);
  c.abort(Error('cancelled'));
  await assertion;
  await expect(p(6)).rejects.toThrow();
  expect(() =>
    createJitoHeliusReadonlyPacer('https://example.com/', c.signal),
  ).toThrow();
});
