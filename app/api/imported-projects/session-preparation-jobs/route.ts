import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { UUID } from '@/lib/wallet-operation';
import { walletRequest } from '@/lib/wallet-request';
import {
  sessionJobColumns,
  readOwnedJobSession,
  queueSessionPreparation,
  runSessionPreparationJobs,
  decodeSessionJobs,
  type SessionPreparationJob,
} from '@/lib/session-preparation-jobs';
import { prepareOwnedImportedSwap } from '@/lib/prepare-owned-imported-swap';
import { captureTradeSession } from '@/lib/imported-trade-session-server';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to read preparation jobs.' }, 401);
  const q = new URL(request.url).searchParams,
    projectId = q.get('projectId'),
    sessionId = q.get('sessionId'),
    jobId = q.get('jobId');
  if (
    !projectId ||
    !sessionId ||
    !UUID.test(projectId) ||
    !UUID.test(sessionId) ||
    (jobId !== null && !UUID.test(jobId))
  )
    return json({ error: 'Choose a saved session and job.' }, 400);
  try {
    const db = getD1(),
      session = await readOwnedJobSession(
        db,
        user.userId,
        projectId,
        sessionId,
      );
    if (!session) return json({ error: 'Owned session unavailable.' }, 404);
    if (jobId) {
      const row = await db
        .prepare(
          'SELECT entry,state,preparation_id AS preparationId,payload FROM session_preparation_jobs WHERE owner_id=? AND project_id=? AND session_id=? AND id=?',
        )
        .bind(user.userId, projectId, sessionId, jobId)
        .first<{
          entry: number;
          state: string;
          preparationId: string | null;
          payload: string | null;
        }>();
      if (!row) return json({ error: 'Owned job unavailable.' }, 404);
      if (row.state !== 'prepared' || !row.payload)
        return json({ error: 'Unsigned preparation is not ready.' }, 409);
      const value = JSON.parse(row.payload);
      if (
        value.history?.id !== row.preparationId ||
        Date.parse(value.order?.expiresAt) <= Date.now() ||
        Date.parse(value.balance?.expiresAt) <= Date.now() ||
        !Number.isFinite(Date.parse(value.order?.expiresAt)) ||
        !Number.isFinite(Date.parse(value.balance?.expiresAt))
      )
        return json(
          { error: 'Queued unsigned preparation expired. Queue a fresh job.' },
          410,
        );
      const e = session.terms.entries.find((e) => e.entry === row.entry);
      if (!e) throw new Error();
      await captureTradeSession(
        db,
        user.userId,
        { sessionId, revision: 1, entry: row.entry },
        {
          projectId,
          projectRevision: session.terms.projectRevision,
          wallet: e.wallet,
          walletRevision: e.walletRevision,
          side: session.terms.side,
          unitsRaw: e.unitsRaw,
          mint: session.terms.mint,
          decimals: session.terms.decimals,
        },
      );
      const current = await db
        .prepare(
          "SELECT 1 FROM imported_token_projects p JOIN workspace_wallets w ON w.owner_id=p.owner_id WHERE p.owner_id=? AND p.id=? AND p.revision=? AND p.archived=0 AND w.chain='Solana' AND w.address=? AND w.revision=? AND w.archived=0",
        )
        .bind(
          user.userId,
          projectId,
          session.terms.projectRevision,
          e.wallet,
          e.walletRevision,
        )
        .first();
      if (!current)
        return json({ error: 'Project or wallet context changed.' }, 409);
      const gate = await db
        .prepare(
          'SELECT next_allowed_at AS deadline FROM wallet_balance_gates WHERE owner_id=?',
        )
        .bind(user.userId)
        .first<{ deadline: number }>();
      return json({
        ...value,
        reviewWaitMs: Math.min(
          15000,
          Math.max(0, (gate?.deadline ?? 0) - Date.now()),
        ),
      });
    }
    const rows = await db
      .prepare(
        `SELECT ${sessionJobColumns} FROM session_preparation_jobs WHERE owner_id=? AND project_id=? AND session_id=? ORDER BY created_at DESC,id LIMIT 101`,
      )
      .bind(user.userId, projectId, sessionId)
      .all<SessionPreparationJob>();
    return json({
      projectId,
      sessionId,
      jobs: decodeSessionJobs(rows.results, projectId, sessionId),
      executionAllowed: false,
    });
  } catch {
    return json(
      { error: 'Preparation job context unavailable. Reload the session.' },
      503,
    );
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to manage preparation jobs.' }, 401);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin request rejected.' }, 403);
  let body: {
    action: string;
    id?: string;
    projectId: string;
    sessionId: string;
    entry?: number;
  };
  try {
    if (
      !request.headers
        .get('content-type')
        ?.toLowerCase()
        .startsWith('application/json')
    )
      throw new Error();
    body = (await walletRequest(request, 2048)) as typeof body;
    if (
      !['queue', 'runDue', 'cancel'].includes(body.action) ||
      !UUID.test(body.projectId) ||
      !UUID.test(body.sessionId) ||
      Object.keys(body).sort().join(',') !==
        (body.action === 'queue'
          ? 'action,entry,id,projectId,sessionId'
          : body.action === 'cancel'
            ? 'action,id,projectId,sessionId'
            : 'action,projectId,sessionId') ||
      (body.action === 'cancel' && (!body.id || !UUID.test(body.id))) ||
      (body.action === 'queue' &&
        (!body.id ||
          !UUID.test(body.id) ||
          !Number.isInteger(body.entry) ||
          body.entry! < 1 ||
          body.entry! > 25))
    )
      throw new Error();
  } catch {
    return json({ error: 'Choose exact saved session job terms.' }, 400);
  }
  try {
    const db = getD1(),
      session = await readOwnedJobSession(
        db,
        user.userId,
        body.projectId,
        body.sessionId,
      );
    if (!session) return json({ error: 'Owned session unavailable.' }, 404);
    if (body.action === 'cancel') {
      const bindings = [user.userId, body.projectId, body.sessionId, body.id!];
      const read = () =>
        db
          .prepare(
            `SELECT ${sessionJobColumns} FROM session_preparation_jobs WHERE owner_id=? AND project_id=? AND session_id=? AND id=?`,
          )
          .bind(...bindings)
          .first<SessionPreparationJob>();
      const existing = await read();
      if (!existing)
        return json({ error: 'Owned preparation job unavailable.' }, 404);
      if (['queued', 'running'].includes(existing.state)) {
        await db
          .prepare(
            "UPDATE session_preparation_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner_id=? AND project_id=? AND session_id=? AND id=? AND state IN ('queued','running')",
          )
          .bind(...bindings)
          .run();
      }
      const row = await read();
      if (!row || row.state !== 'cancelled')
        return json(
          { error: 'Job already completed. Reload its retained result.' },
          409,
        );
      const [job] = decodeSessionJobs([row], body.projectId, body.sessionId);
      return json({ job, executionAllowed: false });
    }
    if (body.action === 'queue') {
      const job = await queueSessionPreparation(
        db,
        user.userId,
        body.id!,
        session,
        body.entry!,
      );
      return json({ job, executionAllowed: false });
    }
    return json(
      await runSessionPreparationJobs(
        db,
        prepareOwnedImportedSwap,
        {
          owner: user.userId,
          projectId: body.projectId,
          sessionId: body.sessionId,
        },
        1,
      ),
    );
  } catch {
    return json(
      {
        error:
          'Preparation job unavailable, already queued or session context changed. Reload jobs.',
      },
      409,
    );
  }
}
