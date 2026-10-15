import {
  previewOwnedPumpGroupRuntime,
  authorizeOwnedPumpGroupSigning,
} from '@/lib/pump-group-runtime-service';
import { recoverOwnedPumpLaunchGroup } from '@/lib/pump-launch-group-terminal-service';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { PumpPreflightError } from '@/lib/owned-pump-preflight';
import {
  parsePumpGroupRequest,
  parsePumpGroupReadRequest,
  encodePumpGroupObservationCursor,
} from '@/lib/pump-launch-group-request';
import {
  preparePumpLaunchGroupReview,
  readPumpLaunchGroupReview,
  listPumpLaunchGroupPage,
  approvePumpLaunchGroupReview,
  refreshPumpLaunchGroupReview,
  registerPumpLaunchGroupSignatures,
  cancelUnsignedPumpLaunchGroupReview,
} from '@/lib/pump-launch-group-review-service';
import {
  collectOwnedPumpGroupObservation,
  listOwnedPumpGroupObservations,
} from '@/lib/pump-launch-group-observation-service';
import { getSolanaIndexerRpcEndpoint } from '@/lib/solana-rpc';
import { balanceRpc } from '@/lib/wallet-balances';
import {
  readOwnedPumpGroupBroadcast,
  prepareOwnedPumpGroupBroadcast,
  registerOwnedPumpGroupTip,
  submitOwnedPumpGroupBroadcast,
} from '@/lib/pump-group-broadcast-service';
import { recoverOwnedPumpGroupBroadcast } from '@/lib/pump-group-broadcast-recovery';
import type { PumpLaunchRpc } from '@/lib/pump-launch-simulation';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(status === 429 ? { 'retry-after': '5' } : {}),
    },
  });
const failure = (error: unknown) =>
  error instanceof PumpPreflightError
    ? json({ error: error.message }, error.status)
    : json(
        {
          error:
            'Group action did not complete. Read saved history before retrying; no new approval, signature or execution should be assumed.',
        },
        502,
      );
const readOnlyMethods = new Set([
  'getGenesisHash',
  'getLatestBlockhash',
  'getFeeForMessage',
  'getMultipleAccounts',
  'getAccountInfo',
  'getBlockHeight',
  'getEpochInfo',
  'getTransaction',
  'getMinimumBalanceForRentExemption',
  'isBlockhashValid',
  'simulateTransaction',
  'simulateBundle',
]);
function configuredRpc(): PumpLaunchRpc {
  const endpoint = getSolanaIndexerRpcEndpoint(),
    url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('Group provider configuration is unavailable.');
  return (method, params, signal) => {
    signal.throwIfAborted();
    if (!readOnlyMethods.has(method))
      throw new Error('Group API has no submission or mutation transport.');
    return balanceRpc(endpoint, method, params, signal, fetch, 2097152);
  };
}
export async function GET(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user)
      return json({ error: 'Sign in to read complete launch groups.' }, 401);
    const query = parsePumpGroupReadRequest(new URL(request.url).searchParams),
      db = getD1();
    if (query.kind === 'projects')
      return json(
        await listPumpLaunchGroupPage(
          db,
          user.userId,
          query.projectId,
          query.page,
        ),
      );
    if (query.kind === 'review')
      return json(await readPumpLaunchGroupReview(db, user.userId, query.id));
    const page = await listOwnedPumpGroupObservations(
      db,
      user.userId,
      query.id,
      query.position,
    );
    return json({
      observations: page.observations,
      nextCursor: page.nextPosition
        ? encodePumpGroupObservationCursor(page.nextPosition)
        : null,
    });
  } catch (error) {
    return failure(error);
  }
}
async function boundedBody(request: Request, signal: AbortSignal) {
  const reader = request.body?.getReader();
  if (!reader) throw new PumpPreflightError('Group request required.', 400);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  try {
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const part = await new Promise<ReadableStreamReadResult<Uint8Array>>(
        (resolve, reject) => {
          const abort = () => {
            void reader.cancel().catch(() => {});
            reject(
              new PumpPreflightError(
                'Group request cancelled or timed out.',
                408,
              ),
            );
          };
          deadline.addEventListener('abort', abort, { once: true });
          if (deadline.aborted) {
            abort();
            deadline.removeEventListener('abort', abort);
            return;
          }
          reader
            .read()
            .then(resolve, reject)
            .finally(() => deadline.removeEventListener('abort', abort));
        },
      );
      if (part.done) break;
      size += part.value.length;
      if (size > 65536) {
        await reader.cancel();
        throw new PumpPreflightError('Group request is too large.', 413);
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch (error) {
    if (error instanceof PumpPreflightError) throw error;
    throw new PumpPreflightError('Invalid complete-group JSON request.', 400);
  } finally {
    reader.releaseLock();
  }
}
export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user)
      return json({ error: 'Sign in to review a complete launch group.' }, 401);
    const origin = new URL(request.url).origin;
    if (request.headers.get('origin') !== origin)
      return json({ error: 'Use this site for complete-group actions.' }, 403);
    if (
      request.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase() !== 'application/json'
    )
      return json({ error: 'JSON required.' }, 415);
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(60000),
    ]);
    const action = parsePumpGroupRequest(
        await boundedBody(request, signal),
        origin,
      ),
      db = getD1();
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
        throw new PumpPreflightError('Owned group project not found.', 404);
    } else {
      const row = await db
        .prepare(
          "SELECT project_id FROM pump_launch_reviews WHERE owner_id=? AND id=? AND json_extract(review,'$.format')='pump-launch-group-review-v1'",
        )
        .bind(user.userId, action.id)
        .first<{ project_id: string }>();
      if (!row)
        throw new PumpPreflightError(
          'Owned complete-group review not found.',
          404,
        );
      projectId = row.project_id;
    }
    if (
      !['register', 'broadcast-read', 'broadcast-register-tip'].includes(
        action.action,
      )
    ) {
      const now = Date.now(),
        key = JSON.stringify([
          'pump-groups-v1',
          user.userId,
          projectId,
          action.action,
        ]);
      const claim = await db
        .prepare(
          'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
        )
        .bind(key, now + 5000, now)
        .run();
      if (!claim.meta.changes)
        throw new PumpPreflightError(
          'Wait 5 seconds before repeating this group action. Saved history remains available.',
          429,
        );
    }
    if (action.action === 'register')
      return json(
        await registerPumpLaunchGroupSignatures(
          db,
          user.userId,
          action.id,
          action.consent,
          action.transactions,
          signal,
        ),
      );
    if (action.action === 'cancel')
      return json(
        await cancelUnsignedPumpLaunchGroupReview(
          db,
          user.userId,
          action.id,
          signal,
        ),
      );
    if (action.action === 'broadcast-read')
      return json(
        await readOwnedPumpGroupBroadcast(db, user.userId, action.id),
      );
    if (action.action === 'broadcast-register-tip')
      return json(
        await registerOwnedPumpGroupTip(
          db,
          user.userId,
          action.id,
          action.broadcastId,
          action.sha256,
          action.transaction,
          signal,
        ),
      );
    const rpc = configuredRpc();
    if (action.action === 'broadcast-prepare')
      return json(
        await prepareOwnedPumpGroupBroadcast(
          db,
          user.userId,
          action.id,
          action.tipRaw,
          action.tipFeeLimitRaw,
          signal,
          rpc,
        ),
      );
    if (action.action === 'broadcast-submit')
      return json(
        await submitOwnedPumpGroupBroadcast(
          db,
          user.userId,
          action.id,
          action.consent,
          signal,
          rpc,
        ),
      );
    if (action.action === 'broadcast-recover')
      return json(
        await recoverOwnedPumpGroupBroadcast(
          db,
          user.userId,
          action.id,
          signal,
          rpc,
        ),
      );
    if (action.action === 'runtime-preview')
      return json(
        await previewOwnedPumpGroupRuntime(
          db,
          user.userId,
          action.id,
          signal,
          rpc,
        ),
      );
    if (action.action === 'authorize-signing')
      return json(
        await authorizeOwnedPumpGroupSigning(
          db,
          user.userId,
          action.id,
          action.previewId,
          action.consent,
          action.codeConsent,
          signal,
          rpc,
        ),
      );
    if (action.action === 'recover')
      return json(
        await recoverOwnedPumpLaunchGroup(
          db,
          user.userId,
          action.id,
          signal,
          rpc,
        ),
      );
    if (action.action === 'prepare')
      return json(
        await preparePumpLaunchGroupReview(
          db,
          user.userId,
          action.terms,
          signal,
          rpc,
        ),
      );
    if (action.action === 'approve')
      return json(
        await approvePumpLaunchGroupReview(
          db,
          user.userId,
          action.id,
          action.consent,
          signal,
          rpc,
        ),
      );
    if (action.action === 'revalidate')
      return json(
        await refreshPumpLaunchGroupReview(
          db,
          user.userId,
          action.id,
          signal,
          rpc,
        ),
      );
    return json(
      await collectOwnedPumpGroupObservation(
        db,
        user.userId,
        action.id,
        signal,
        rpc,
      ),
    );
  } catch (error) {
    return failure(error);
  }
}
