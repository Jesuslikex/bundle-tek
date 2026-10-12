import { afterEach, expect, it, vi } from 'vitest';
import { createRetainedRunStatusFeed } from './retained-run-status-feed';
afterEach(() => vi.useRealTimers());
it('requires explicit start and schedules saved reads after completion without overlap', async () => {
  vi.useFakeTimers();
  let finish!: (value: boolean) => void;
  const read = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const onState = vi.fn();
  const feed = createRetainedRunStatusFeed({
    unavailable: () => null,
    read,
    onState,
  });
  await vi.advanceTimersByTimeAsync(30000);
  expect(read).not.toHaveBeenCalled();
  feed.start();
  feed.start();
  await vi.advanceTimersByTimeAsync(30000);
  expect(read).toHaveBeenCalledTimes(1);
  finish(true);
  await vi.advanceTimersByTimeAsync(4999);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  expect(onState.mock.calls.some(([state]) => state.reads === 1)).toBe(true);
  feed.destroy();
});
it('aborts unavailable reads, ignores stale completions and resumes only an enabled feed', async () => {
  vi.useFakeTimers();
  let reason: string | null = null;
  let finish!: (value: boolean) => void;
  const read = vi.fn(
    (_signal: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const onState = vi.fn();
  const feed = createRetainedRunStatusFeed({
    unavailable: () => reason,
    read,
    onState,
  });
  feed.start();
  const signal = read.mock.calls[0][0];
  const oldFinish = finish;
  reason = 'Browser offline';
  feed.availabilityChanged();
  expect(signal.aborted).toBe(true);
  oldFinish(true);
  await vi.advanceTimersByTimeAsync(30000);
  expect(onState).toHaveBeenLastCalledWith({
    status: 'paused',
    reason,
    reads: 0,
    retryInMs: null,
  });
  reason = null;
  feed.availabilityChanged();
  expect(read).toHaveBeenCalledTimes(2);
  feed.stop();
  finish(true);
  await vi.advanceTimersByTimeAsync(30000);
  feed.availabilityChanged();
  expect(read).toHaveBeenCalledTimes(2);
  expect(onState.mock.calls.at(-1)?.[0].status).toBe('off');
});
it('backs off failed reads to 30 seconds and resets after success', async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValue(false),
    onState = vi.fn();
  const feed = createRetainedRunStatusFeed({
    unavailable: () => null,
    read,
    onState,
  });
  feed.start();
  await vi.advanceTimersByTimeAsync(0);
  for (const delay of [5000, 10000, 20000, 30000]) {
    expect(onState.mock.calls.at(-1)?.[0].retryInMs).toBe(delay);
    await vi.advanceTimersByTimeAsync(delay);
  }
  read.mockResolvedValue(true);
  await vi.advanceTimersByTimeAsync(30000);
  expect(onState.mock.calls.at(-1)?.[0]).toMatchObject({
    status: 'waiting',
    reads: 1,
    retryInMs: null,
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(onState.mock.calls.at(-1)?.[0].reads).toBe(2);
  feed.destroy();
});
