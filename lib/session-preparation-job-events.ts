import { UUID } from './wallet-operation';
export const sessionJobLabels = {
  queued: 'Unsigned preparation queued',
  running: 'Unsigned preparation started',
  prepared: 'Unsigned packet prepared',
  failed: 'Preparation failed',
  cancelled: 'Preparation cancelled',
} as const;
export type SessionJobEvent = {
  id: string;
  sequence: number;
  projectId: string;
  sessionId: string;
  jobId: string;
  createdAt: string;
  document: {
    id: string;
    entry: number;
    state: keyof typeof sessionJobLabels;
    attempts: number;
    preparationId: string | null;
    error: string | null;
  };
};
export function decodeSessionJobEvent(value: unknown): SessionJobEvent {
  const e = value as SessionJobEvent,
    d = e?.document;
  if (
    !e ||
    typeof e.id !== 'string' ||
    !/^[a-f0-9]{32}$/.test(e.id) ||
    !Number.isSafeInteger(e.sequence) ||
    e.sequence < 1 ||
    ![e.projectId, e.sessionId, e.jobId].every(
      (id) => typeof id === 'string' && UUID.test(id),
    ) ||
    typeof e.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(e.createdAt)) ||
    !d ||
    Object.keys(d).sort().join(',') !==
      'attempts,entry,error,id,preparationId,state' ||
    d.id !== e.jobId ||
    !Number.isInteger(d.entry) ||
    d.entry < 1 ||
    d.entry > 25 ||
    !Object.hasOwn(sessionJobLabels, d.state) ||
    !Number.isInteger(d.attempts) ||
    d.attempts < 0 ||
    d.attempts > 3 ||
    (d.state === 'running' && d.attempts === 0) ||
    (d.state === 'prepared'
      ? typeof d.preparationId !== 'string' ||
        !UUID.test(d.preparationId) ||
        d.attempts === 0
      : d.preparationId !== null) ||
    (d.error !== null &&
      ![
        'rate-limited',
        'context-changed',
        'balance-unavailable',
        'service-unavailable',
        'lease-expired',
      ].includes(d.error))
  )
    throw new Error('Preparation job event differs.');
  return e;
}
export function decodeSessionJobEventPage(
  value: unknown,
  projectId?: string,
  sessionId?: string,
  after?: number,
) {
  const p = value as { events: unknown[]; nextCursor: string | null };
  if (!p || !Array.isArray(p.events) || p.events.length > 50)
    throw new Error('Preparation job history unavailable.');
  const events = p.events.map(decodeSessionJobEvent);
  if (
    events.some(
      (e, i) =>
        (projectId && e.projectId !== projectId) ||
        (sessionId && e.sessionId !== sessionId) ||
        (after !== undefined && e.sequence >= after) ||
        (i > 0 && e.sequence >= events[i - 1].sequence),
    ) ||
    new Set(events.map((e) => e.id)).size !== events.length ||
    (p.nextCursor !== null && p.nextCursor !== events.at(-1)?.id)
  )
    throw new Error('Preparation job history scope or cursor differs.');
  return { events, nextCursor: p.nextCursor };
}
export function sessionJobEventDetail(e: SessionJobEvent) {
  const d = e.document;
  return (
    `Session ${e.sessionId} · job ${e.jobId} · entry ${d.entry} · captured ${d.state} · attempts ${d.attempts}/3` +
    (d.preparationId ? ` · unsigned preparation ${d.preparationId}` : '') +
    (d.error ? ` · ${d.error}` : '')
  );
}
