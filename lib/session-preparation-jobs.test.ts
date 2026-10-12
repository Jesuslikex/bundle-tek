import { expect, it } from 'vitest';
import { decodeSessionJobs } from './session-preparation-jobs';
const id = '00000000-0000-4000-8000-000000000001',
  projectId = '00000000-0000-4000-8000-000000000002',
  sessionId = '00000000-0000-4000-8000-000000000003',
  date = '2026-10-11T12:00:00.000Z';
const job = {
  id,
  projectId,
  sessionId,
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
it('admits only scoped bounded saved job states and exact packet references', () => {
  expect(decodeSessionJobs([job], projectId, sessionId)).toHaveLength(1);
  for (const jobs of [
    [job, job],
    [{ ...job, sessionId: projectId }],
    [{ ...job, entry: 26 }],
    [{ ...job, attempts: 4 }],
    [{ ...job, state: 'prepared' }],
    [{ ...job, notBefore: 'bad' }],
    [{ ...job, lastError: 'provider secret' }],
  ])
    expect(() => decodeSessionJobs(jobs, projectId, sessionId)).toThrow();
});
