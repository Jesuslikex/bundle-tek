import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({
  run: vi
    .fn()
    .mockResolvedValue({ processed: 0, errors: 0, executionAllowed: false }),
}));
vi.mock('../lib/conditional-monitor-server', () => ({
  runConditionalMonitors: mocks.run,
}));
import worker from './conditional-monitor';
it('has no active scheduler, public execution endpoint or default background activation', async () => {
  const config = JSON.parse(
    readFileSync('wrangler.conditional-monitor.jsonc', 'utf8'),
  ) as {
    vars: { CONDITIONAL_MONITOR_ENABLED: string };
    triggers: { crons: string[] };
  };
  expect(config.vars.CONDITIONAL_MONITOR_ENABLED).toBe('false');
  expect(config.triggers.crons).toEqual([]);
  mocks.run.mockClear();
  const waitUntil = vi.fn();
  await worker.scheduled({} as ScheduledController, { DB: {} as D1Database }, {
    waitUntil,
  } as unknown as ExecutionContext);
  expect(mocks.run).not.toHaveBeenCalled();
  expect(waitUntil).not.toHaveBeenCalled();
  expect((await worker.fetch()).status).toBe(404);
});
it('dispatches only explicitly enabled read-only monitoring', async () => {
  mocks.run.mockClear();
  const db = {} as D1Database,
    waitUntil = vi.fn();
  await worker.scheduled(
    {} as ScheduledController,
    { DB: db, CONDITIONAL_MONITOR_ENABLED: 'true' },
    { waitUntil } as unknown as ExecutionContext,
  );
  expect(mocks.run).toHaveBeenCalledWith(db);
  expect(waitUntil).toHaveBeenCalledTimes(1);
  await waitUntil.mock.calls[0][0];
});
