import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { launchEvidenceId } from '@/lib/account-launch-evidence';
import { PumpPreflightError } from '@/lib/owned-pump-preflight';
import {
  readOwnedPumpGroupReceiptEvidence,
  retainOwnedPumpGroupReceiptEvidence,
} from '@/lib/pump-group-receipt-evidence-service';
import { getSolanaIndexerRpcEndpoint } from '@/lib/solana-rpc';
import { balanceRpc } from '@/lib/wallet-balances';
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
const failure = (e: unknown) =>
  e instanceof DOMException && ['AbortError', 'TimeoutError'].includes(e.name)
    ? json(
        {
          error:
            'Receipt history request cancelled or timed out. Load saved evidence before retrying the same save.',
        },
        408,
      )
    : e instanceof PumpPreflightError
      ? json({ error: e.message }, e.status)
      : json(
          {
            error:
              'Launch receipt history could not be confirmed. Load saved evidence or retry the same save request.',
          },
          503,
        );
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to view saved launch receipts.' }, 401);
  const params = new URL(request.url).searchParams,
    id = params.get('reviewId');
  if (params.size !== 1 || !launchEvidenceId(id))
    return json({ error: 'Select one saved launch group.' }, 400);
  try {
    return json(
      await readOwnedPumpGroupReceiptEvidence(
        getD1(),
        user.userId,
        id,
        AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]),
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
async function body(request: Request, signal: AbortSignal) {
  const reader = request.body?.getReader();
  if (!reader)
    throw new PumpPreflightError('Receipt request identity required.', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 512) {
        await reader.cancel();
        throw new PumpPreflightError('Receipt request is too large.', 413);
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch (e) {
    if (e instanceof PumpPreflightError) throw e;
    throw new PumpPreflightError(
      signal.aborted
        ? 'Receipt request cancelled or timed out.'
        : 'Invalid receipt request.',
      signal.aborted ? 408 : 400,
    );
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to save launch receipt evidence.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Use this site to save launch history.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  try {
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(45_000),
    ]);
    const value = (await body(
      request,
      AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    )) as { reviewId?: unknown; requestId?: unknown };
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'requestId,reviewId' ||
      !launchEvidenceId(value.reviewId) ||
      !launchEvidenceId(value.requestId)
    )
      return json(
        { error: 'Select a launch group and exact save request identity.' },
        400,
      );
    // Resolve configuration lazily: retained same-identity retries need no
    // provider configuration and cannot accidentally repeat a provider read.
    return json(
      await retainOwnedPumpGroupReceiptEvidence(
        getD1(),
        user.userId,
        value.reviewId,
        value.requestId,
        signal,
        async (method, params, deadline) => {
          if (!['getGenesisHash', 'getTransaction'].includes(method))
            throw new Error('Launch receipt history is read-only.');
          const endpoint = getSolanaIndexerRpcEndpoint(),
            url = new URL(endpoint);
          if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.hash
          )
            throw new Error('Launch receipt provider unavailable.');
          return balanceRpc(endpoint, method, params, deadline, fetch, 2097152);
        },
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
