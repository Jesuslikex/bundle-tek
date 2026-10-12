import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  run: vi.fn().mockResolvedValue({ processed: 0, executionAllowed: false }),
  prepare: vi.fn(),
}));
vi.mock('../lib/session-preparation-jobs', () => ({
  runSessionPreparationJobs: mocks.run,
}));
vi.mock('../lib/prepare-owned-imported-swap', () => ({
  prepareOwnedImportedSwap: mocks.prepare,
}));
import worker from './session-preparation';
it('keeps the worker disabled by default and exposes no public execution endpoint', async () => {
  mocks.run.mockClear();
  const waitUntil = vi.fn();
  await worker.scheduled({} as ScheduledController, { DB: {} as D1Database }, {
    waitUntil,
  } as unknown as ExecutionContext);
  expect(mocks.run).not.toHaveBeenCalled();
  expect(waitUntil).not.toHaveBeenCalled();
  expect((await worker.fetch()).status).toBe(404);
});
it('dispatches only explicitly enabled scheduled work through the shared unsigned service', async () => {
  mocks.run.mockClear();
  const db = {} as D1Database,
    waitUntil = vi.fn();
  await worker.scheduled(
    {} as ScheduledController,
    { DB: db, SESSION_PREPARATION_ENABLED: 'true' },
    { waitUntil } as unknown as ExecutionContext,
  );
  expect(mocks.run).toHaveBeenCalledWith(db, mocks.prepare);
  expect(waitUntil).toHaveBeenCalledTimes(1);
  await waitUntil.mock.calls[0][0];
  expect(mocks.prepare).not.toHaveBeenCalled();
});
