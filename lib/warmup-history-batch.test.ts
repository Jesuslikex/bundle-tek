import { afterEach, expect, it, vi } from 'vitest';
import { createWarmupHistoryBatch } from './warmup-history-batch';
import type { WarmupHistoryRun } from './warmup-history-run';
const saved = (count = 2): WarmupHistoryRun => ({
  id: 'run',
  planId: 'plan',
  planRevision: 1,
  state: 'planned',
  revision: 1,
  leaseUntil: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  document: {
    chain: 'Solana',
    wallets: Array.from({ length: count }, (_, i) => ({
      address: `wallet-${i}`,
      revision: 1,
    })),
    results: [],
  },
});
const progressed = (run: WarmupHistoryRun): WarmupHistoryRun => ({
  ...run,
  revision: run.revision + 2,
  state:
    run.document.results.length + 1 === run.document.wallets.length
      ? 'completed'
      : 'planned',
  document: {
    ...run.document,
    results: [
      ...run.document.results,
      {
        address: run.document.wallets[run.document.results.length].address,
        error: 'Fixture provider failure remains retained.',
      },
    ],
  },
});
afterEach(() => vi.useRealTimers());
it('recovers saved progress after an aborted in-flight advance without repeating the completed wallet', async () => {
  vi.useFakeTimers();
  let run = saved(),
    finish!: (value: WarmupHistoryRun) => void;
  const advance = vi.fn(
    (_current: WarmupHistoryRun, _signal: AbortSignal) =>
      new Promise<WarmupHistoryRun>((resolve) => {
        finish = resolve;
      }),
  );
  const onRun = vi.fn();
  const batch = createWarmupHistoryBatch({
    runId: 'run',
    planId: 'plan',
    planRevision: 1,
    available: () => true,
    read: async () => run,
    advance,
    onRun,
    onState: vi.fn(),
  });
  batch.start();
  await vi.advanceTimersByTimeAsync(0);
  const firstSignal = advance.mock.calls[0][1];
  batch.stop();
  expect(firstSignal.aborted).toBe(true);
  run = progressed(run);
  finish(run);
  await vi.advanceTimersByTimeAsync(0);
  expect(onRun).toHaveBeenCalledTimes(1);
  batch.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(advance.mock.calls[1][0].document.results).toHaveLength(1);
  expect(advance.mock.calls[1][0].revision).toBe(3);
  run = progressed(run);
  finish(run);
  await vi.advanceTimersByTimeAsync(60000);
  expect(advance).toHaveBeenCalledTimes(2);
  expect(run.state).toBe('completed');
  batch.destroy();
});
it('holds captured wallet changes and never exceeds the twenty-wallet saved run', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const held = { ...saved(), leaseUntil: 15000 };
  const read = vi
    .fn()
    .mockResolvedValueOnce(held)
    .mockResolvedValueOnce({
      ...held,
      document: {
        ...held.document,
        wallets: [
          { address: 'different', revision: 1 },
          held.document.wallets[1],
        ],
      },
    });
  const advance = vi.fn(),
    onState = vi.fn();
  const heldBatch = createWarmupHistoryBatch({
    runId: 'run',
    planId: 'plan',
    planRevision: 1,
    available: () => true,
    read,
    advance,
    onRun: vi.fn(),
    onState,
  });
  heldBatch.start();
  await vi.advanceTimersByTimeAsync(20000);
  expect(advance).not.toHaveBeenCalled();
  expect(onState.mock.calls.at(-1)?.[0].status).toBe('error');
  heldBatch.destroy();
  let run = saved(20);
  const next = vi.fn(
    async (current: WarmupHistoryRun) => (run = progressed(current)),
  );
  const batch = createWarmupHistoryBatch({
    runId: 'run',
    planId: 'plan',
    planRevision: 1,
    available: () => true,
    read: async () => run,
    advance: next,
    onRun: vi.fn(),
    onState: vi.fn(),
  });
  batch.start();
  await vi.advanceTimersByTimeAsync(400000);
  expect(next).toHaveBeenCalledTimes(20);
  expect(run.state).toBe('completed');
  batch.destroy();
});
it('requires explicit start, advances remaining wallets serially and waits 15 seconds after each saved result', async () => {
  vi.useFakeTimers();
  let run = saved();
  const read = vi.fn(async () => run),
    advance = vi.fn(
      async (current: WarmupHistoryRun) => (run = progressed(current)),
    );
  const onRun = vi.fn(),
    onState = vi.fn();
  const batch = createWarmupHistoryBatch({
    runId: 'run',
    planId: 'plan',
    planRevision: 1,
    available: () => true,
    read,
    advance,
    onRun,
    onState,
  });
  await vi.advanceTimersByTimeAsync(30000);
  expect(read).not.toHaveBeenCalled();
  batch.start();
  batch.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(advance).toHaveBeenCalledTimes(1);
  expect(advance.mock.calls[0][0].revision).toBe(1);
  await vi.advanceTimersByTimeAsync(14999);
  expect(advance).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(advance).toHaveBeenCalledTimes(2);
  expect(advance.mock.calls[1][0].revision).toBe(3);
  expect(onState.mock.calls.at(-1)?.[0]).toMatchObject({
    status: 'completed',
    checked: 2,
    total: 2,
  });
  expect(run.document.results).toHaveLength(2);
  expect(run.document.results[0].error).toContain('retained');
  await vi.advanceTimersByTimeAsync(90000);
  expect(advance).toHaveBeenCalledTimes(2);
  batch.destroy();
});
it('waits out existing leases and the shared rate gate by reloading saved state before retrying', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const run = { ...saved(1), leaseUntil: 45000 };
  const read = vi.fn(async () => run),
    advance = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(progressed(run));
  const batch = createWarmupHistoryBatch({
    runId: 'run',
    planId: 'plan',
    planRevision: 1,
    available: () => true,
    read,
    advance,
    onRun: vi.fn(),
    onState: vi.fn(),
  });
  batch.start();
  await vi.advanceTimersByTimeAsync(44999);
  expect(advance).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(advance).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15000);
  expect(advance).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenCalledTimes(3);
  batch.destroy();
});
it('aborts hidden or stopped reads, ignores late results and never restarts automatically', async () => {
  vi.useFakeTimers();
  let available = true,
    finish!: (run: WarmupHistoryRun) => void;
  const read = vi.fn(
    (_signal: AbortSignal) =>
      new Promise<WarmupHistoryRun>((resolve) => {
        finish = resolve;
      }),
  );
  const advance = vi.fn(),
    onRun = vi.fn(),
    onState = vi.fn();
  const batch = createWarmupHistoryBatch({
    runId: 'run',
    planId: 'plan',
    planRevision: 1,
    available: () => available,
    read,
    advance,
    onRun,
    onState,
  });
  batch.start();
  const signal = read.mock.calls[0][0];
  available = false;
  batch.visibilityChanged();
  expect(signal.aborted).toBe(true);
  finish(saved());
  await vi.advanceTimersByTimeAsync(30000);
  expect(advance).not.toHaveBeenCalled();
  expect(onRun).not.toHaveBeenCalled();
  available = true;
  batch.visibilityChanged();
  await vi.advanceTimersByTimeAsync(30000);
  expect(read).toHaveBeenCalledTimes(1);
  batch.start();
  expect(read).toHaveBeenCalledTimes(2);
  batch.destroy();
});
it('holds changed contexts, stopped runs, non-progress and ambiguous network failures without automatic replay', async () => {
  vi.useFakeTimers();
  for (const patch of [
    { planRevision: 2 },
    { planId: 'other' },
    { state: 'paused' as const },
    { state: 'cancelled' as const },
  ]) {
    const advance = vi.fn();
    const batch = createWarmupHistoryBatch({
      runId: 'run',
      planId: 'plan',
      planRevision: 1,
      available: () => true,
      read: async () => ({ ...saved(), ...patch }),
      advance,
      onRun: vi.fn(),
      onState: vi.fn(),
    });
    batch.start();
    await vi.advanceTimersByTimeAsync(30000);
    expect(advance).not.toHaveBeenCalled();
    batch.destroy();
  }
  for (const advance of [
    vi.fn(async (run: WarmupHistoryRun) => run),
    vi.fn().mockRejectedValue(new Error('Network interrupted')),
  ]) {
    const onState = vi.fn();
    const batch = createWarmupHistoryBatch({
      runId: 'run',
      planId: 'plan',
      planRevision: 1,
      available: () => true,
      read: async () => saved(),
      advance,
      onRun: vi.fn(),
      onState,
    });
    batch.start();
    await vi.advanceTimersByTimeAsync(90000);
    expect(advance).toHaveBeenCalledTimes(1);
    expect(onState.mock.calls.at(-1)?.[0].status).toBe('error');
    batch.destroy();
  }
});
