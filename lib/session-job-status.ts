import {
  decodeSessionJobs,
  type SessionPreparationJob,
} from './session-preparation-jobs';
import type { TradeSession } from './imported-trade-session';
export function decodeSessionJobStatus(value: unknown, session: TradeSession) {
  const v = value as {
    projectId: string;
    sessionId: string;
    executionAllowed: boolean;
    jobs: unknown;
  };
  if (
    !v ||
    v.projectId !== session.terms.projectId ||
    v.sessionId !== session.id ||
    v.executionAllowed !== false
  )
    throw new Error('Preparation job status scope differs.');
  const jobs = decodeSessionJobs(v.jobs, v.projectId, v.sessionId);
  if (
    jobs.some(
      (j) => ['running', 'prepared'].includes(j.state) && j.attempts === 0,
    ) ||
    jobs.some((j) => !session.terms.entries.some((e) => e.entry === j.entry))
  )
    throw new Error('Preparation job entry differs.');
  return jobs;
}
export function requireCurrentJobStatus(
  next: SessionPreparationJob[],
  prior: SessionPreparationJob[],
) {
  for (const old of prior) {
    const j = next.find((j) => j.id === old.id);
    if (
      !j ||
      j.projectId !== old.projectId ||
      j.sessionId !== old.sessionId ||
      j.entry !== old.entry ||
      j.notBefore !== old.notBefore ||
      j.createdAt !== old.createdAt ||
      j.attempts < old.attempts ||
      (old.state === 'queued' &&
        ['running', 'prepared'].includes(j.state) &&
        j.attempts <= old.attempts) ||
      Date.parse(j.updatedAt) < Date.parse(old.updatedAt) ||
      Date.parse(j.nextAttemptAt) < Date.parse(old.nextAttemptAt) ||
      (['prepared', 'failed', 'cancelled'].includes(old.state) &&
        JSON.stringify(j) !== JSON.stringify(old)) ||
      (old.state === 'running' &&
        j.state === 'queued' &&
        j.attempts === old.attempts &&
        j.lastError === null)
    )
      throw new Error(
        'Preparation job status moved backwards. Reload to reconcile.',
      );
  }
}
