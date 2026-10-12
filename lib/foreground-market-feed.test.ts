import { afterEach, expect, it, vi } from 'vitest';
import { createForegroundMarketFeed } from './foreground-market-feed';
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('starts only explicitly and waits 30 seconds after each completed read without overlap', async () => {
  vi.useFakeTimers();
  let release!: (value: boolean) => void;
  const read = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  const onState = vi.fn();
  const feed = createForegroundMarketFeed({
    available: () => true,
    read,
    onState,
  });
  await vi.advanceTimersByTimeAsync(90000);
  expect(read).not.toHaveBeenCalled();
  feed.start();
  feed.start();
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(90000);
  expect(read).toHaveBeenCalledTimes(1);
  release(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(onState).toHaveBeenLastCalledWith({
    status: 'running',
    reason: '',
    reads: 1,
  });
  await vi.advanceTimersByTimeAsync(29999);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  feed.destroy();
});
it('aborts hidden-tab reads and ignores late completion; visibility alone never restarts', async () => {
  vi.useFakeTimers();
  let available = true,
    release!: (value: boolean) => void;
  const read = vi.fn(
    (_signal: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  const onState = vi.fn();
  const feed = createForegroundMarketFeed({
    available: () => available,
    read,
    onState,
  });
  feed.start();
  const signal = read.mock.calls[0][0];
  available = false;
  feed.pause('Tab hidden');
  expect(signal.aborted).toBe(true);
  release(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(onState).toHaveBeenLastCalledWith({
    status: 'paused',
    reason: 'Tab hidden',
    reads: 0,
  });
  available = true;
  await vi.advanceTimersByTimeAsync(90000);
  expect(read).toHaveBeenCalledTimes(1);
  feed.start();
  expect(read).toHaveBeenCalledTimes(2);
  feed.destroy();
});
it('stops on a failed read and refuses hidden/offline starts or unavailable scheduled reads', async () => {
  vi.useFakeTimers();
  let available = false;
  const read = vi.fn().mockResolvedValue(false),
    onState = vi.fn();
  const feed = createForegroundMarketFeed({
    available: () => available,
    read,
    onState,
  });
  feed.start();
  expect(read).not.toHaveBeenCalled();
  available = true;
  feed.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(onState.mock.calls.at(-1)?.[0].status).toBe('error');
  await vi.advanceTimersByTimeAsync(90000);
  expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValue(true);
  feed.start();
  await vi.advanceTimersByTimeAsync(0);
  available = false;
  await vi.advanceTimersByTimeAsync(30000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(onState.mock.calls.at(-1)?.[0].status).toBe('paused');
  feed.stop();
  expect(onState.mock.calls.at(-1)?.[0].status).toBe('off');
  feed.destroy();
});
it('backs off transient failures, caps delays, and resets the delay after success', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const read = vi
    .fn()
    .mockResolvedValue({ status: 'retry', reason: 'Rate limited.' });
  const onState = vi.fn();
  const feed = createForegroundMarketFeed({
    available: () => true,
    read,
    onState,
  });
  feed.start();
  await vi.advanceTimersByTimeAsync(0);
  for (const delay of [30000, 60000, 120000, 240000, 300000, 300000]) {
    expect(onState.mock.calls.at(-1)?.[0]).toEqual({
      status: 'running',
      reason: `Rate limited. Retrying in ${delay / 1000} seconds.`,
      reads: 0,
    });
    const count = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(read).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(count + 1);
  }
  read.mockResolvedValueOnce(true);
  await vi.advanceTimersByTimeAsync(300000);
  expect(onState).toHaveBeenLastCalledWith({
    status: 'running',
    reason: '',
    reads: 1,
  });
  await vi.advanceTimersByTimeAsync(30000);
  expect(onState.mock.calls.at(-1)?.[0].reason).toContain(
    'Retrying in 30 seconds.',
  );
  feed.destroy();
});
it('honors Retry-After, adds jitter, and cancels scheduled retries on stop', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const read = vi
    .fn()
    .mockResolvedValue({
      status: 'retry',
      reason: 'Unavailable.',
      retryAfterMs: 90000,
    });
  const feed = createForegroundMarketFeed({
    available: () => true,
    read,
    onState: vi.fn(),
  });
  feed.start();
  await vi.advanceTimersByTimeAsync(89999);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  feed.stop();
  await vi.advanceTimersByTimeAsync(600000);
  expect(read).toHaveBeenCalledTimes(2);
  read.mockResolvedValue({ status: 'retry', reason: 'Unavailable.' });
  feed.start();
  await vi.advanceTimersByTimeAsync(32999);
  expect(read).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(4);
  feed.destroy();
});
it('pauses a scheduled retry when unavailable and ignores late retry results after abort', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  let available = true;
  const read = vi
    .fn()
    .mockResolvedValue({ status: 'retry', reason: 'Temporary.' });
  const onState = vi.fn();
  const feed = createForegroundMarketFeed({
    available: () => available,
    read,
    onState,
  });
  feed.start();
  await vi.advanceTimersByTimeAsync(0);
  available = false;
  await vi.advanceTimersByTimeAsync(30000);
  expect(read).toHaveBeenCalledTimes(1);
  expect(onState.mock.calls.at(-1)?.[0].status).toBe('paused');
  available = true;
  let release!: (value: { status: 'retry'; reason: string }) => void;
  read.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  feed.start();
  feed.destroy();
  release({ status: 'retry', reason: 'Late.' });
  await vi.advanceTimersByTimeAsync(600000);
  expect(read).toHaveBeenCalledTimes(2);
});
