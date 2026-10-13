import {
  decodeTradeSession,
  sessionEntryNotBefore,
  type TradeSession,
} from './imported-trade-session';
import { UUID } from './wallet-operation';
export type SessionPreparationJob = {
  id: string;
  projectId: string;
  sessionId: string;
  entry: number;
  state: 'queued' | 'running' | 'prepared' | 'failed' | 'cancelled';
  attempts: number;
  notBefore: string;
  nextAttemptAt: string;
  preparationId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};
export const sessionJobColumns =
  'id,project_id AS projectId,session_id AS sessionId,entry,state,attempts,not_before AS notBefore,next_attempt_at AS nextAttemptAt,preparation_id AS preparationId,last_error AS lastError,created_at AS createdAt,updated_at AS updatedAt';
export function decodeSessionJobs(
  value: unknown,
  projectId: string,
  sessionId: string,
): SessionPreparationJob[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error('Preparation jobs unavailable.');
  const jobs = value as SessionPreparationJob[];
  if (
    new Set(jobs.map((j) => j?.id)).size !== jobs.length ||
    jobs.some(
      (j) =>
        !j ||
        !UUID.test(j.id) ||
        j.projectId !== projectId ||
        j.sessionId !== sessionId ||
        !Number.isInteger(j.entry) ||
        j.entry < 1 ||
        j.entry > 25 ||
        !['queued', 'running', 'prepared', 'failed', 'cancelled'].includes(
          j.state,
        ) ||
        !Number.isInteger(j.attempts) ||
        j.attempts < 0 ||
        j.attempts > 3 ||
        !['notBefore', 'nextAttemptAt', 'createdAt', 'updatedAt'].every((k) =>
          Number.isFinite(Date.parse(j[k as 'notBefore'])),
        ) ||
        (j.state === 'prepared'
          ? !j.preparationId || !UUID.test(j.preparationId)
          : j.preparationId !== null) ||
        (j.lastError !== null &&
          ![
            'rate-limited',
            'context-changed',
            'balance-unavailable',
            'service-unavailable',
            'lease-expired',
          ].includes(j.lastError)),
    )
  )
    throw new Error('Preparation job context differs.');
  return jobs;
}
export async function readOwnedJobSession(
  db: D1Database,
  owner: string,
  projectId: string,
  sessionId: string,
): Promise<TradeSession | null> {
  const row = await db
    .prepare(
      'SELECT id,revision,state,document,created_at AS createdAt,updated_at AS updatedAt FROM imported_trade_sessions WHERE owner_id=? AND project_id=? AND id=?',
    )
    .bind(owner, projectId, sessionId)
    .first<{
      id: string;
      revision: number;
      state: string;
      document: string;
      createdAt: string;
      updatedAt: string;
    }>();
  return row
    ? decodeTradeSession({ ...row, terms: JSON.parse(row.document) })
    : null;
}
export async function queueSessionPreparation(
  db: D1Database,
  owner: string,
  id: string,
  session: TradeSession,
  entry: number,
) {
  const e = session.terms.entries.find((e) => e.entry === entry);
  if (session.terms.endsAt && Date.now() >= Date.parse(session.terms.endsAt))
    throw new Error('DCA session end time has been reached.');
  if (!e) throw new Error('Choose a saved entry.');
  const old = await db
    .prepare(
      `SELECT ${sessionJobColumns} FROM session_preparation_jobs WHERE owner_id=? AND id=?`,
    )
    .bind(owner, id)
    .first<SessionPreparationJob>();
  if (old) {
    if (
      old.projectId !== session.terms.projectId ||
      old.sessionId !== session.id ||
      old.entry !== entry
    )
      throw new Error('Job ID terms differ.');
    return old;
  }
  const now = new Date().toISOString(),
    due = sessionEntryNotBefore(session.terms, entry) ?? now;
  await db
    .prepare(
      "INSERT INTO session_preparation_jobs(id,owner_id,project_id,session_id,entry,state,not_before,next_attempt_at,created_at,updated_at) SELECT ?,?,?,?,?,'queued',?,?,?,? WHERE (SELECT COUNT(*) FROM session_preparation_jobs WHERE owner_id=? AND project_id=?)<100",
    )
    .bind(
      id,
      owner,
      session.terms.projectId,
      session.id,
      entry,
      due,
      now,
      now,
      now,
      owner,
      session.terms.projectId,
    )
    .run();
  const result = await db
    .prepare(
      `SELECT ${sessionJobColumns} FROM session_preparation_jobs WHERE owner_id=? AND id=?`,
    )
    .bind(owner, id)
    .first<SessionPreparationJob>();
  if (!result) throw new Error('Preparation job limit reached.');
  return result;
}
export type JobScope = { owner: string; projectId: string; sessionId: string };
export async function runSessionPreparationJobs(
  db: D1Database,
  prepare: (
    request: Request,
    owner: string,
    db: D1Database,
  ) => Promise<Response>,
  scope?: JobScope,
  limit = 2,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 2)
    throw new Error('Bounded dispatcher required.');
  // Lost leases receive bounded retries. A stale worker cannot write with a replaced token.
  await db
    .prepare(
      "UPDATE session_preparation_jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,lease_token=NULL,lease_until=NULL,last_error='lease-expired',next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE state='running' AND julianday(lease_until)<=julianday('now') AND (? IS NULL OR (owner_id=? AND project_id=? AND session_id=?))",
    )
    .bind(
      scope?.owner ?? null,
      scope?.owner ?? '',
      scope?.projectId ?? '',
      scope?.sessionId ?? '',
    )
    .run();
  await db
    .prepare(
      "UPDATE session_preparation_jobs SET state='cancelled',last_error='context-changed',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE state='queued' AND (? IS NULL OR (owner_id=? AND project_id=? AND session_id=?)) AND NOT EXISTS(SELECT 1 FROM imported_trade_sessions s JOIN imported_token_projects p ON p.owner_id=s.owner_id AND p.id=s.project_id WHERE s.owner_id=session_preparation_jobs.owner_id AND s.id=session_preparation_jobs.session_id AND s.state='active' AND p.archived=0 AND p.revision=json_extract(s.document,'$.projectRevision'))",
    )
    .bind(
      scope?.owner ?? null,
      scope?.owner ?? '',
      scope?.projectId ?? '',
      scope?.sessionId ?? '',
    )
    .run();
  let processed = 0;
  for (let n = 0; n < limit; n++) {
    const candidate = await db
      .prepare(
        "SELECT j.id,j.owner_id AS owner,j.project_id AS projectId,j.session_id AS sessionId,j.entry,c.revision AS controlRevision FROM session_preparation_jobs j JOIN imported_trade_session_controls c ON c.owner_id=j.owner_id AND c.session_id=j.session_id WHERE j.state='queued' AND j.attempts<3 AND c.state='ready' AND julianday(j.not_before)<=julianday('now') AND julianday(j.next_attempt_at)<=julianday('now') AND (? IS NULL OR (j.owner_id=? AND j.project_id=? AND j.session_id=?)) AND NOT EXISTS(SELECT 1 FROM session_preparation_jobs r WHERE r.owner_id=j.owner_id AND r.state='running' AND julianday(r.lease_until)>julianday('now')) ORDER BY j.next_attempt_at,j.created_at,j.id LIMIT 1",
      )
      .bind(
        scope?.owner ?? null,
        scope?.owner ?? '',
        scope?.projectId ?? '',
        scope?.sessionId ?? '',
      )
      .first<{
        id: string;
        owner: string;
        projectId: string;
        sessionId: string;
        entry: number;
        controlRevision: number;
      }>();
    if (!candidate) break;
    const token = crypto.randomUUID();
    const claim = await db
      .prepare(
        "UPDATE session_preparation_jobs SET state='running',attempts=attempts+1,lease_token=?,lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+45 seconds'),control_revision=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND owner_id=? AND state='queued' AND EXISTS(SELECT 1 FROM imported_trade_session_controls WHERE owner_id=? AND session_id=? AND state='ready' AND revision=?)",
      )
      .bind(
        token,
        candidate.controlRevision,
        candidate.id,
        candidate.owner,
        candidate.owner,
        candidate.sessionId,
        candidate.controlRevision,
      )
      .run();
    if (!claim.meta.changes) continue;
    processed++;
    let code = 502;
    let preparationId: string | null = null;
    try {
      const session = await readOwnedJobSession(
        db,
        candidate.owner,
        candidate.projectId,
        candidate.sessionId,
      );
      const e = session?.terms.entries.find((e) => e.entry === candidate.entry);
      if (!session || !e) throw new Error();
      const request = new Request(
        'https://bundle.internal/api/imported-projects/prepare',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(30000),
          body: JSON.stringify({
            id: candidate.projectId,
            revision: session.terms.projectRevision,
            wallet: e.wallet,
            walletRevision: e.walletRevision,
            side: session.terms.side,
            amount: e.amount,
            session: { sessionId: session.id, revision: 1, entry: e.entry },
          }),
        },
      );
      const result = await prepare(request, candidate.owner, db);
      code = result.status;
      if (result.ok) {
        const value = (await result.json()) as { history: { id: string } };
        if (!UUID.test(value.history?.id)) throw new Error();
        preparationId = value.history.id;
        await db
          .prepare(
            "UPDATE session_preparation_jobs SET state='prepared',preparation_id=?,payload=?,lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND owner_id=? AND state='running' AND lease_token=? AND julianday(lease_until)>julianday('now')",
          )
          .bind(
            preparationId,
            JSON.stringify(value),
            candidate.id,
            candidate.owner,
            token,
          )
          .run();
        continue;
      }
    } catch {
      code = 502;
    }
    const error =
      code === 429
        ? 'rate-limited'
        : code === 409
          ? 'context-changed'
          : code === 422
            ? 'balance-unavailable'
            : 'service-unavailable';
    await db
      .prepare(
        "UPDATE session_preparation_jobs SET state=CASE WHEN attempts>=3 OR ? IN (400,409,422) THEN 'failed' ELSE 'queued' END,lease_token=NULL,lease_until=NULL,last_error=?,next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND owner_id=? AND state='running' AND lease_token=? AND julianday(lease_until)>julianday('now')",
      )
      .bind(code, error, candidate.id, candidate.owner, token)
      .run();
  }
  return { processed, executionAllowed: false };
}
