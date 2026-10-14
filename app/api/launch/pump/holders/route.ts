import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { PumpPreflightError } from '@/lib/owned-pump-preflight';
import { parsePumpHolderRequest } from '@/lib/pump-holder-request';
import {
  preparePumpHolderReview,
  approvePumpHolderReview,
  registerPumpHolderSignedPacket,
  listPumpHolderReviews,
} from '@/lib/pump-holder-review-service';
import {
  submitPumpHolderReview,
  recoverPumpHolderReview,
  cancelPumpHolderReview,
} from '@/lib/pump-holder-execution';
export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(status === 429 ? { 'retry-after': '5' } : {}),
    },
  });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to read holder launch reviews.' }, 401);
  const projectId = new URL(request.url).searchParams.get('projectId');
  if (!projectId || projectId.length > 128)
    return json({ error: 'Choose a project.' }, 400);
  try {
    return json({
      launches: await listPumpHolderReviews(getD1(), user.userId, projectId),
    });
  } catch {
    return json({ error: 'Holder launch history is unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to review a holder launch.' }, 401);
  const origin = new URL(request.url).origin;
  if (request.headers.get('origin') !== origin)
    return json({ error: 'Use this site to review the holder launch.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  const reader = request.body?.getReader();
  if (!reader) return json({ error: 'Holder launch request required.' }, 400);
  let body: unknown;
  try {
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) {
        await reader.cancel();
        return json({ error: 'Request too large.' }, 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return json({ error: 'Invalid holder launch request.' }, 400);
  } finally {
    reader.releaseLock();
  }
  try {
    const action = parsePumpHolderRequest(body, origin),
      db = getD1(),
      signal = AbortSignal.any([request.signal, AbortSignal.timeout(60000)]);
    signal.throwIfAborted();
    let projectId: string;
    if (action.action === 'prepare') {
      projectId = action.terms.projectId;
      if (
        !(await db
          .prepare(
            'SELECT 1 FROM workspace_projects WHERE owner_id=? AND id=? AND archived=0',
          )
          .bind(user.userId, projectId)
          .first())
      )
        throw new PumpPreflightError('Owned holder project not found.', 404);
    } else {
      const row = await db
        .prepare(
          "SELECT project_id FROM pump_launch_reviews WHERE owner_id=? AND id=? AND json_extract(review,'$.format')='pump-create-holders-review-v1'",
        )
        .bind(user.userId, action.id)
        .first<{ project_id: string }>();
      if (!row)
        throw new PumpPreflightError('Owned holder review not found.', 404);
      projectId = row.project_id;
    }
    if (
      ['prepare', 'approve', 'submit', 'recover', 'cancel'].includes(
        action.action,
      )
    ) {
      const now = Date.now(),
        key = JSON.stringify([
          'pump-holders-v1',
          user.userId,
          projectId,
          action.action,
        ]);
      const claimed = await db
        .prepare(
          'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
        )
        .bind(key, now + 5000, now)
        .run();
      if (!claimed.meta.changes)
        throw new PumpPreflightError(
          'Wait 5 seconds before repeating this holder action. Saved history remains available.',
          429,
        );
    }
    if (action.action === 'prepare')
      return json(
        await preparePumpHolderReview(db, user.userId, action.terms, signal),
      );
    if (action.action === 'approve')
      return json(
        await approvePumpHolderReview(
          db,
          user.userId,
          action.id,
          action.consent,
          signal,
        ),
      );
    if (action.action === 'register')
      return json(
        await registerPumpHolderSignedPacket(
          db,
          user.userId,
          action.id,
          action.consent,
          action.transaction,
          signal,
        ),
      );
    if (action.action === 'submit')
      return json(
        await submitPumpHolderReview(
          db,
          user.userId,
          action.id,
          { consent: action.consent, submitApproved: action.submitApproved },
          signal,
        ),
      );
    if (action.action === 'recover')
      return json(
        await recoverPumpHolderReview(db, user.userId, action.id, signal),
      );
    return json(
      await cancelPumpHolderReview(db, user.userId, action.id, signal),
    );
  } catch (error) {
    if (error instanceof PumpPreflightError)
      return json({ error: error.message }, error.status);
    return json(
      {
        error:
          'Holder action did not complete. Reload saved history before retrying. No new approval or submission should be assumed.',
      },
      502,
    );
  }
}
