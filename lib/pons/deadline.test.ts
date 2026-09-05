import { it, expect, vi } from 'vitest';
import { withDeadline } from './deadline';
it('bounds overall operations and aborts stalled RPCs', async () => {
  vi.useFakeTimers();
  try {
    let signal: AbortSignal | undefined;
    const p = withDeadline(
      50,
      async (s) => {
        signal = s;
        return new Promise(() => {});
      },
      'SIMULATION_TIMEOUT',
    );
    const rejected = expect(p).rejects.toMatchObject({
      code: 'SIMULATION_TIMEOUT',
      status: 504,
    });
    await vi.advanceTimersByTimeAsync(51);
    await rejected;
    expect(signal?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
