import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { getSolanaIndexerRpcEndpoint } from '@/lib/solana-rpc';
import { balanceRpc } from '@/lib/wallet-balances';
import { UUID } from '@/lib/wallet-operation';
import {
  SNIPER_GUARD_RPC_METHODS,
  type SniperGuardRpc,
} from '@/lib/sniper-guard-chain';
import { VenueLaunchRecoveryError } from '@/lib/venue-launch-recovery';
import {
  VenueSniperError,
  observeVenueSniper,
  readVenueSniperLaunch,
} from '@/lib/venue-sniper-guard-service';
import { isVenueSniperVenue } from '@/lib/venue-sniper-guard';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(status === 429 ? { 'retry-after': '2' } : {}),
    },
  });
const failure = (error: unknown) =>
  error instanceof VenueSniperError || error instanceof VenueLaunchRecoveryError
    ? json({ error: error.message }, error.status)
    : json(
        {
          error:
            'Sniper Guard could not finish this read. Nothing was signed or sent; it will try again.',
        },
        502,
      );
const allowed = new Set<string>(SNIPER_GUARD_RPC_METHODS);
/** Read-only transport: this route never prepares, signs or sends. */
function configuredRpc(): SniperGuardRpc {
  const endpoint = getSolanaIndexerRpcEndpoint(),
    url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new VenueSniperError('Sniper Guard RPC is not configured.', 503);
  return (method, params, signal) => {
    signal.throwIfAborted();
    if (!allowed.has(method))
      throw new Error('Sniper Guard has no submission or mutation transport.');
    return balanceRpc(endpoint, method, params, signal, fetch, 2097152);
  };
}
const target = (venue: unknown, id: unknown) => {
  if (!isVenueSniperVenue(venue))
    throw new VenueSniperError(
      'Choose a LetsBonk, Surge, StonkFun or Meteora DBC launch.',
      400,
    );
  if (typeof id !== 'string' || !UUID.test(id))
    throw new VenueSniperError('Choose a saved launch.', 400);
  return { venue, id };
};

export async function GET(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return json({ error: 'Sign in to read Sniper Guard.' }, 401);
    const params = new URL(request.url).searchParams;
    const { venue, id } = target(params.get('venue'), params.get('id'));
    return json({
      launch: await readVenueSniperLaunch(getD1(), user.userId, venue, id),
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return json({ error: 'Sign in to run Sniper Guard.' }, 401);
    if (request.headers.get('origin') !== new URL(request.url).origin)
      return json({ error: 'Use this site for Sniper Guard.' }, 403);
    if (
      request.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase() !== 'application/json'
    )
      return json({ error: 'JSON required.' }, 415);
    const text = await request.text();
    if (text.length > 2000) return json({ error: 'Request too large.' }, 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'JSON required.' }, 400);
    }
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== 'action,cursor,id,venue' ||
      body.action !== 'observe' ||
      (body.cursor !== null &&
        (typeof body.cursor !== 'string' || !SIGNATURE.test(body.cursor)))
    )
      return json({ error: 'Sniper Guard request differs.' }, 400);
    const { venue, id } = target(body.venue, body.id);
    const db = getD1(),
      now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
      )
      .bind(
        JSON.stringify(['venue-sniper-guard-v1', user.userId, venue, id]),
        now + 1500,
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
    const launch = await readVenueSniperLaunch(db, user.userId, venue, id);
    return json(
      await observeVenueSniper(
        db,
        user.userId,
        launch,
        body.cursor as string | null,
        configuredRpc(),
        signal,
      ),
    );
  } catch (error) {
    return failure(error);
  }
}
