import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { PumpPreflightError } from '@/lib/owned-pump-preflight';
import { pumpLaunchRpc } from '@/lib/pump-launch-service';
import { parsePumpOrganicRequest } from '@/lib/pump-organic-request';
import {
  planOwnedPumpOrganicSequence,
  preparePumpOrganicBatch,
} from '@/lib/pump-organic-preparation';
import {
  listPumpOrganicSequences,
  observePumpOrganicBatch,
  registerPumpOrganicBatch,
  sendPumpOrganicBuy,
  stopPumpOrganicSequence,
} from '@/lib/pump-organic-service';
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
    return json({ error: 'Sign in to read organic holder buys.' }, 401);
  const projectId = new URL(request.url).searchParams.get('projectId');
  if (!projectId || projectId.length > 128)
    return json({ error: 'Choose a project.' }, 400);
  try {
    return json({
      sequences: await listPumpOrganicSequences(
        getD1(),
        user.userId,
        projectId,
      ),
    });
  } catch {
    return json({ error: 'Organic holder-buy history is unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to run organic holder buys.' }, 401);
  const origin = new URL(request.url).origin;
  if (request.headers.get('origin') !== origin)
    return json({ error: 'Use this site to run organic holder buys.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 1_200_000)
      return json({ error: 'Request too large.' }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Invalid organic holder-buy request.' }, 400);
  }
  try {
    const action = parsePumpOrganicRequest(body),
      db = getD1(),
      signal = AbortSignal.any([request.signal, AbortSignal.timeout(60000)]);
    if (['plan', 'prepare-batch', 'stop'].includes(action.action)) {
      const now = Date.now(),
        key = JSON.stringify(['pump-organic-v1', user.userId, action.action]);
      const claimed = await db
        .prepare(
          'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
        )
        .bind(key, now + (action.action === 'stop' ? 0 : 3000), now)
        .run();
      if (!claimed.meta.changes)
        throw new PumpPreflightError(
          'Wait a few seconds before repeating this action.',
          429,
        );
    }
    switch (action.action) {
      case 'plan':
        return json(
          await planOwnedPumpOrganicSequence(
            db,
            user.userId,
            action.terms,
            signal,
            pumpLaunchRpc(),
          ),
        );
      case 'prepare-batch':
        return json(
          await preparePumpOrganicBatch(
            db,
            user.userId,
            action.sequenceId,
            action.batch,
            signal,
            pumpLaunchRpc(),
          ),
        );
      case 'register':
        return json(
          await registerPumpOrganicBatch(db, user.userId, action.batchId, {
            consent: action.consent,
            transactions: action.transactions,
          }),
        );
      case 'send':
        return json(
          await sendPumpOrganicBuy(
            db,
            user.userId,
            action.batchId,
            action.index,
            signal,
            pumpLaunchRpc(),
          ),
        );
      case 'observe':
        return json(
          await observePumpOrganicBatch(
            db,
            user.userId,
            action.batchId,
            signal,
            pumpLaunchRpc(),
          ),
        );
      case 'stop':
        return json(
          await stopPumpOrganicSequence(db, user.userId, action.sequenceId),
        );
    }
  } catch (error) {
    if (error instanceof PumpPreflightError)
      return json({ error: error.message }, error.status);
    return json(
      {
        error:
          error instanceof Error && error.message.length < 300
            ? error.message
            : 'Organic holder-buy action did not complete. Reload before retrying; no send should be assumed.',
      },
      502,
    );
  }
}
