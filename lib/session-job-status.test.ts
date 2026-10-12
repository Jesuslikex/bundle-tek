import { expect, it } from 'vitest';
import {
  decodeSessionJobStatus,
  requireCurrentJobStatus,
} from './session-job-status';
import type { SessionPreparationJob } from './session-preparation-jobs';
import type { TradeSession } from './imported-trade-session';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const date = '2026-10-11T12:00:00.000Z';
const session = {
  id: id(1),
  terms: { projectId: id(2), entries: [{ entry: 1 }] },
} as TradeSession;
const job: SessionPreparationJob = {
  id: id(3),
  projectId: id(2),
  sessionId: id(1),
  entry: 1,
  state: 'queued',
  attempts: 0,
  notBefore: date,
  nextAttemptAt: date,
  preparationId: null,
  lastError: null,
  createdAt: date,
  updatedAt: date,
};
const page = (jobs: unknown) => ({
  projectId: id(2),
  sessionId: id(1),
  executionAllowed: false,
  jobs,
});
it('admits only complete owned session status without execution permission', () => {
  expect(decodeSessionJobStatus(page([job]), session)).toEqual([job]);
  for (const p of [
    { ...page([job]), executionAllowed: true },
    { ...page([job]), projectId: id(4) },
    { ...page([job]), sessionId: id(4) },
    page([{ ...job, entry: 2 }]),
    page([{ ...job, state: 'running' }]),
    page([job, job]),
  ])
    expect(() => decodeSessionJobStatus(p, session)).toThrow();
});
it('admits running, retry and terminal progress plus new retained jobs', () => {
  const running = { ...job, state: 'running' as const, attempts: 1 };
  const retry = {
    ...running,
    state: 'queued' as const,
    lastError: 'rate-limited',
    nextAttemptAt: '2026-10-11T12:00:30.000Z',
    updatedAt: '2026-10-11T12:00:01.000Z',
  };
  const prepared = {
    ...retry,
    state: 'prepared' as const,
    attempts: 2,
    lastError: null,
    preparationId: id(4),
    updatedAt: '2026-10-11T12:00:31.000Z',
  };
  expect(() => requireCurrentJobStatus([running], [job])).not.toThrow();
  expect(() => requireCurrentJobStatus([retry], [running])).not.toThrow();
  expect(() => requireCurrentJobStatus([prepared], [retry])).not.toThrow();
  expect(() =>
    requireCurrentJobStatus([prepared, { ...job, id: id(5) }], [prepared]),
  ).not.toThrow();
});
it('rejects removed, rebound, rewound or impossible status and retains terminal identity', () => {
  const running = { ...job, state: 'running' as const, attempts: 1 };
  for (const rows of [
    [],
    [{ ...running, entry: 2 }],
    [{ ...running, notBefore: '2026-10-11T12:00:01.000Z' }],
    [{ ...running, attempts: 0 }],
    [{ ...running, updatedAt: '2026-10-11T11:00:00.000Z' }],
    [{ ...running, state: 'queued' as const }],
    [{ ...running, createdAt: '2026-10-11T11:00:00.000Z' }],
  ])
    expect(() => requireCurrentJobStatus(rows, [running])).toThrow();
  expect(() =>
    requireCurrentJobStatus([{ ...job, state: 'running' }], [job]),
  ).toThrow();
  const cancelled = { ...running, state: 'cancelled' as const };
  expect(() => requireCurrentJobStatus([cancelled], [running])).not.toThrow();
  for (const p of [
    { state: 'queued' as const },
    { lastError: 'context-changed' },
    { attempts: 2 },
    { updatedAt: '2026-10-11T12:00:01.000Z' },
  ])
    expect(() =>
      requireCurrentJobStatus([{ ...cancelled, ...p }], [cancelled]),
    ).toThrow();
});
