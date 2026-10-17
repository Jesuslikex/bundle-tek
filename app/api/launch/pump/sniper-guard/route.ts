import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { PumpPreflightError } from '@/lib/owned-pump-preflight';
import { getSolanaIndexerRpcEndpoint } from '@/lib/solana-rpc';
import { balanceRpc } from '@/lib/wallet-balances';
import { UUID } from '@/lib/wallet-operation';
import {
  SNIPER_GUARD_RPC_METHODS,
  type SniperGuardRpc,
} from '@/lib/sniper-guard-chain';
import {
  armSniperGuard,
  observeSniperGuard,
  readSniperGuard,
  readSniperGuardLaunch,
  saveSniperGuardSettings,
  stopSniperGuard,
} from '@/lib/sniper-guard-service';
import {
  cancelSniperNuke,
  sendSniperNukeSell,
  observeSniperNuke,
  prepareSniperNuke,
  readSniperNuke,
  registerSniperNuke,
} from '@/lib/sniper-nuke-service';
import type { SniperNukeConsent } from '@/lib/sniper-nuke';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(status === 429 ? { 'retry-after': '2' } : {}),
    },
  });
const failure = (error: unknown) =>
  error instanceof PumpPreflightError
    ? json({ error: error.message }, error.status)
    : json(
        {
          error:
            'Sniper Guard could not finish this read. Nothing was signed or sent; reload the guard and try again.',
        },
        502,
      );
// Reads only, except nuke-send, which alone may send one user-signed sell.
const allowed = new Set<string>([
  ...SNIPER_GUARD_RPC_METHODS,
  'getSignatureStatuses',
  'getBlockHeight',
]);
function configuredRpc(canSend = false): SniperGuardRpc {
  const endpoint = getSolanaIndexerRpcEndpoint(),
    url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new PumpPreflightError('Sniper Guard RPC is not configured.', 503);
  return (method, params, signal) => {
    signal.throwIfAborted();
    if (!allowed.has(method) && !(canSend && method === 'sendTransaction'))
      throw new Error('Sniper Guard has no submission or mutation transport.');
    return balanceRpc(endpoint, method, params, signal, fetch, 2097152);
  };
}
const idOf = (value: unknown) => {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new PumpPreflightError('Choose a saved Nuke batch.', 400);
  return value;
};
const reviewIdOf = (value: unknown) => {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new PumpPreflightError('Choose a saved launch review.', 400);
  return value;
};
const revisionOf = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new PumpPreflightError(
      'Reload Sniper Guard before changing it.',
      400,
    );
  return value as number;
};

export async function GET(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return json({ error: 'Sign in to read Sniper Guard.' }, 401);
    const reviewId = reviewIdOf(
      new URL(request.url).searchParams.get('reviewId'),
    );
    const db = getD1();
    const { launch, launchState } = await readSniperGuardLaunch(
      db,
      user.userId,
      reviewId,
    );
    return json({
      guard: await readSniperGuard(db, user.userId, reviewId),
      nuke: await readSniperNuke(db, user.userId, reviewId),
      launch,
      launchState,
    });
  } catch (error) {
    return failure(error);
  }
}

type Body = {
  action?: unknown;
  reviewId?: unknown;
  revision?: unknown;
  settings?: unknown;
  batchId?: unknown;
  sellId?: unknown;
  consent?: unknown;
  signed?: unknown;
};
export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return json({ error: 'Sign in to change Sniper Guard.' }, 401);
    if (request.headers.get('origin') !== new URL(request.url).origin)
      return json({ error: 'Use this site for Sniper Guard actions.' }, 403);
    if (
      request.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase() !== 'application/json'
    )
      return json({ error: 'JSON required.' }, 415);
    const text = await request.text();
    if (text.length > 60000) return json({ error: 'Request too large.' }, 413);
    let body: Body;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'JSON required.' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return json({ error: 'Sniper Guard request differs.' }, 400);
    const action = body.action,
      reviewId = reviewIdOf(body.reviewId),
      db = getD1();
    const keys = Object.keys(body).sort().join(',');
    const expected: Record<string, string> = {
      save: 'action,reviewId,revision,settings',
      arm: 'action,reviewId,revision',
      observe: 'action,reviewId,revision',
      stop: 'action,reviewId,revision',
      'nuke-prepare': 'action,reviewId',
      'nuke-register': 'action,consent,reviewId,signed',
      'nuke-observe': 'action,batchId,reviewId',
      'nuke-cancel': 'action,batchId,reviewId',
      'nuke-send': 'action,batchId,reviewId,sellId',
    };
    if (typeof action !== 'string' || expected[action] !== keys)
      return json({ error: 'Sniper Guard request differs.' }, 400);
    const now = Date.now(),
      gate = await db
        .prepare(
          'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
        )
        .bind(
          JSON.stringify(['sniper-guard-v1', user.userId, reviewId]),
          now +
            (action === 'observe' || action === 'nuke-observe' ? 1500 : 1000),
          now,
        )
        .run();
    if (!gate.meta.changes)
      return json(
        { error: 'Sniper Guard is already checking. Wait a moment.' },
        429,
      );
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(25000),
    ]);
    if (action === 'nuke-prepare')
      return json(
        await prepareSniperNuke(
          db,
          user.userId,
          reviewId,
          configuredRpc(),
          signal,
        ),
      );
    if (action === 'nuke-register')
      return json(
        await registerSniperNuke(
          db,
          user.userId,
          reviewId,
          body.consent as SniperNukeConsent,
          body.signed as { id: string; transaction: string }[],
        ),
      );
    if (action === 'nuke-observe')
      return json(
        await observeSniperNuke(
          db,
          user.userId,
          reviewId,
          idOf(body.batchId),
          configuredRpc(),
          signal,
        ),
      );
    if (action === 'nuke-send')
      return json(
        await sendSniperNukeSell(
          db,
          user.userId,
          reviewId,
          idOf(body.batchId),
          idOf(body.sellId),
          configuredRpc(true),
          signal,
        ),
      );
    if (action === 'nuke-cancel')
      return json(
        await cancelSniperNuke(db, user.userId, reviewId, idOf(body.batchId)),
      );
    if (action === 'save')
      return json(
        await saveSniperGuardSettings(
          db,
          user.userId,
          reviewId,
          body.settings,
          body.revision === null ? null : revisionOf(body.revision),
        ),
      );
    const revision = revisionOf(body.revision);
    if (action === 'arm')
      return json(await armSniperGuard(db, user.userId, reviewId, revision));
    if (action === 'stop')
      return json(await stopSniperGuard(db, user.userId, reviewId, revision));
    return json(
      await observeSniperGuard(
        db,
        user.userId,
        reviewId,
        revision,
        configuredRpc(),
        signal,
      ),
    );
  } catch (error) {
    return failure(error);
  }
}
