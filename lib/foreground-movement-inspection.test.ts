import { afterEach, expect, it, vi } from 'vitest';
import { createForegroundMovementInspection } from './foreground-movement-inspection';
import { SupplyMonitorReadError } from './supply-monitor-read';
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const page = (requestedCursor: string | null, nextCursor: string | null) => ({
  requestedCursor,
  nextCursor,
  completeThroughBoundary: nextCursor === null,
  anchor: 200,
});
it('starts explicitly, reads sequential pages and stops at the boundary', async () => {
  vi.useFakeTimers();
  const read = vi
      .fn()
      .mockResolvedValueOnce(page(null, 'next'))
      .mockResolvedValueOnce(page('next', null)),
    onState = vi.fn();
  const scan = createForegroundMovementInspection({
    available: () => true,
    read,
    onState,
  });
  await vi.advanceTimersByTimeAsync(60000);
  expect(read).not.toHaveBeenCalled();
  scan.start();
  scan.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(onState.mock.calls.at(-1)![0]).toMatchObject({
    status: 'complete',
    pages: 2,
  });
  await vi.advanceTimersByTimeAsync(90000);
  expect(read).toHaveBeenCalledTimes(2);
  scan.destroy();
});
it('retries the same cursor with backoff and Retry-After before advancing', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const read = vi
    .fn()
    .mockRejectedValueOnce(
      new SupplyMonitorReadError('Rate limited', true, 45000),
    )
    .mockResolvedValueOnce(page(null, 'next'))
    .mockResolvedValueOnce(page('next', null));
  const scan = createForegroundMovementInspection({
    available: () => true,
    read,
    onState: () => {},
  });
  scan.start();
  await vi.advanceTimersByTimeAsync(44999);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read.mock.calls.map((c) => c[0])).toEqual([null, null]);
  await vi.advanceTimersByTimeAsync(30000);
  expect(read.mock.calls.map((c) => c[0])).toEqual([null, null, 'next']);
  scan.destroy();
});
it('caps repeated failures at five retries and does not retry terminal scope errors', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const read = vi
      .fn()
      .mockRejectedValue(new SupplyMonitorReadError('Unavailable', true)),
    onState = vi.fn();
  const scan = createForegroundMovementInspection({
    available: () => true,
    read,
    onState,
  });
  scan.start();
  await vi.advanceTimersByTimeAsync(1000000);
  expect(read).toHaveBeenCalledTimes(6);
  expect(onState.mock.calls.at(-1)![0].status).toBe('error');
  read.mockRejectedValue(new SupplyMonitorReadError('Changed scope', false));
  scan.start();
  await vi.advanceTimersByTimeAsync(1000000);
  expect(read).toHaveBeenCalledTimes(7);
  scan.destroy();
});
it('serializes panels and skips a queued read after stop without late updates', async () => {
  vi.useFakeTimers();
  let release!: (value: ReturnType<typeof page>) => void;
  const first = vi.fn(
      () =>
        new Promise<ReturnType<typeof page>>((resolve) => {
          release = resolve;
        }),
    ),
    second = vi.fn().mockResolvedValue(page(null, null)),
    state = vi.fn();
  const one = createForegroundMovementInspection({
      available: () => true,
      read: first,
      onState: () => {},
    }),
    two = createForegroundMovementInspection({
      available: () => true,
      read: second,
      onState: state,
    });
  one.start();
  two.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
  two.stop();
  const calls = state.mock.calls.length;
  release(page(null, null));
  await vi.advanceTimersByTimeAsync(0);
  expect(second).not.toHaveBeenCalled();
  expect(state).toHaveBeenCalledTimes(calls);
  one.destroy();
  two.destroy();
});
it('pauses hidden/offline work, aborts the request and never resumes implicitly', async () => {
  vi.useFakeTimers();
  let available = false,
    release!: (value: ReturnType<typeof page>) => void;
  const read = vi.fn(
      (_cursor: string | null, _signal: AbortSignal) =>
        new Promise<ReturnType<typeof page>>((resolve) => {
          release = resolve;
        }),
    ),
    onState = vi.fn();
  const scan = createForegroundMovementInspection({
    available: () => available,
    read,
    onState,
  });
  scan.start();
  expect(read).not.toHaveBeenCalled();
  available = true;
  scan.start();
  await vi.advanceTimersByTimeAsync(0);
  scan.pause();
  expect(read.mock.calls[0][1].aborted).toBe(true);
  release(page(null, 'next'));
  await vi.advanceTimersByTimeAsync(100000);
  expect(read).toHaveBeenCalledTimes(1);
  expect(onState.mock.calls.at(-1)![0].status).toBe('paused');
  scan.destroy();
});
it('stops at its page limit and rejects repeated cursors, changed anchors and missing progress', async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValue(page(null, 'next')),
    onState = vi.fn();
  let scan = createForegroundMovementInspection({
    available: () => true,
    read,
    onState,
    maxPages: 1,
  });
  scan.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(onState.mock.calls.at(-1)![0].status).toBe('limit');
  scan.destroy();
  for (const bad of [
    { ...page('next', 'next') },
    { ...page('next', null), anchor: 201 },
    { ...page(null, null) },
    { ...page('next', null), completeThroughBoundary: false },
  ]) {
    read
      .mockReset()
      .mockResolvedValueOnce(page(null, 'next'))
      .mockResolvedValueOnce(bad);
    scan = createForegroundMovementInspection({
      available: () => true,
      read,
      onState,
    });
    scan.start();
    await vi.advanceTimersByTimeAsync(30000);
    expect(onState.mock.calls.at(-1)![0].status).toBe('error');
    scan.destroy();
  }
});
