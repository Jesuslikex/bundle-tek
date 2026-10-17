import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { env } from '@/lib/server-env';
import { getSolanaIndexerRpcEndpoint } from '@/lib/solana-rpc';
import { balanceRpc } from '@/lib/wallet-balances';
import { prepareSolanaSwap } from '@/lib/warmup-swap-quote';
import { simulateImportedSwap } from '@/lib/imported-swap-simulation';
import { VolumePlanError } from '@/lib/volume-bot-plan';
import { parseVolumeBotRequest } from '@/lib/volume-bot-request';
import {
  cancelVolumeSession,
  createVolumeSession,
  estimateVolumeSession,
  listVolumeSessions,
  observeVolumeBatch,
  prepareVolumeBatch,
  registerVolumeBatch,
  sendVolumeTrade,
  VolumeBotError,
  type VolumeDeps,
} from '@/lib/volume-bot-service';
export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(status === 429 ? { 'retry-after': '3' } : {}),
    },
  });
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function volumeDeps(): VolumeDeps {
  const endpoint = getSolanaIndexerRpcEndpoint(),
    url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new VolumeBotError('Volume Bot provider is not configured.', 503);
  const key = (env as unknown as Record<string, unknown>).JUPITER_API_KEY;
  return {
    rpc: (method, params, signal) =>
      balanceRpc(endpoint, method, params, signal, fetch, 2097152),
    prepareSwap: (input, signal) => {
      if (typeof key !== 'string' || !key.trim())
        throw new VolumeBotError(
          'Swap preparation service is not configured.',
          503,
        );
      return prepareSolanaSwap(input, key, signal);
    },
    simulate: (order, signal) => simulateImportedSwap(order, signal),
  };
}

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to read Volume Bot sessions.' }, 401);
  const projectId = new URL(request.url).searchParams.get('projectId');
  if (!projectId || !UUID.test(projectId))
    return json({ error: 'Choose a project.' }, 400);
  try {
    return json({
      sessions: await listVolumeSessions(getD1(), user.userId, projectId),
    });
  } catch {
    return json({ error: 'Volume Bot history is unavailable.' }, 503);
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to run the Volume Bot.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Use this site to run the Volume Bot.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 200_000) return json({ error: 'Request too large.' }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Invalid Volume Bot request.' }, 400);
  }
  let action;
  try {
    action = parseVolumeBotRequest(body);
  } catch (error) {
    return json(
      {
        error:
          error instanceof VolumePlanError
            ? error.message
            : 'Invalid Volume Bot request.',
      },
      400,
    );
  }
  try {
    const db = getD1(),
      owner = user.userId,
      signal = AbortSignal.any([request.signal, AbortSignal.timeout(55_000)]);
    if (['estimate', 'create', 'prepare-batch'].includes(action.action)) {
      const now = Date.now();
      const claimed = await db
        .prepare(
          'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
        )
        .bind(JSON.stringify(['volume-bot-v1', owner]), now + 3000, now)
        .run();
      if (!claimed.meta.changes)
        return json({ error: 'Wait a few seconds before repeating this.' }, 429);
    }
    switch (action.action) {
      case 'estimate':
        return json(
          await estimateVolumeSession(db, owner, action, signal, volumeDeps().rpc),
        );
      case 'create':
        return json(
          await createVolumeSession(db, owner, action, signal, volumeDeps().rpc),
        );
      case 'prepare-batch':
        return json(
          await prepareVolumeBatch(
            db,
            owner,
            action.sessionId,
            signal,
            volumeDeps(),
          ),
        );
      case 'register':
        return json(
          await registerVolumeBatch(db, owner, action.batchId, action),
        );
      case 'send':
        return json(
          await sendVolumeTrade(
            db,
            owner,
            action.batchId,
            action.index,
            signal,
            volumeDeps().rpc,
          ),
        );
      case 'observe':
        return json(
          await observeVolumeBatch(
            db,
            owner,
            action.batchId,
            signal,
            volumeDeps().rpc,
          ),
        );
      case 'cancel':
        return json(await cancelVolumeSession(db, owner, action.sessionId));
    }
  } catch (error) {
    if (error instanceof VolumeBotError)
      return json({ error: error.message }, error.status);
    if (error instanceof VolumePlanError)
      return json({ error: error.message }, 400);
    return json(
      {
        error:
          error instanceof Error && error.message.length < 300
            ? error.message
            : 'Volume Bot action did not complete. Reload before retrying; no send should be assumed.',
      },
      502,
    );
  }
}
