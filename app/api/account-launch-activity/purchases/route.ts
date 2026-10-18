import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { launchEvidenceId } from '@/lib/account-launch-evidence';
import { PumpPreflightError } from '@/lib/owned-pump-preflight';
import {
  readOwnedPumpPurchaseCostHistory,
  readOwnedPumpPurchaseCostPlan,
  recordOwnedPumpPurchaseCosts,
} from '@/lib/pump-purchase-cost-service';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const failure = (error: unknown) =>
  error instanceof DOMException &&
  ['AbortError', 'TimeoutError'].includes(error.name)
    ? json(
        {
          error:
            'The request stopped or timed out. Reload saved buy costs before retrying the same save.',
        },
        408,
      )
    : error instanceof PumpPreflightError
      ? json({ error: error.message }, error.status)
      : json(
          {
            error:
              'Buy costs could not be verified. Reload saved buy costs before retrying.',
          },
          503,
        );
const deadline = (request: Request) =>
  AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]);
export async function GET(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user)
      return json({ error: 'Sign in to review saved buy costs.' }, 401);
    const params = new URL(request.url).searchParams,
      reviewId = params.get('reviewId'),
      receiptId = params.get('receiptId');
    if (
      !launchEvidenceId(reviewId) ||
      ![1, 2].includes(params.size) ||
      [...params.keys()].some((k) => k !== 'reviewId' && k !== 'receiptId') ||
      params.getAll('reviewId').length !== 1 ||
      params.getAll('receiptId').length > 1 ||
      (params.has('receiptId') && !launchEvidenceId(receiptId))
    )
      return json(
        { error: 'Select one saved launch and optional exact receipt.' },
        400,
      );
    const signal = deadline(request);
    signal.throwIfAborted();
    const result = receiptId
      ? await readOwnedPumpPurchaseCostPlan(
          getD1(),
          user.userId,
          reviewId,
          receiptId,
          signal,
        )
      : await readOwnedPumpPurchaseCostHistory(
          getD1(),
          user.userId,
          reviewId,
          signal,
        );
    signal.throwIfAborted();
    return json(result);
  } catch (error) {
    return failure(error);
  }
}
async function body(request: Request, signal: AbortSignal) {
  const reader = request.body?.getReader();
  if (!reader)
    throw new PumpPreflightError('A buy cost review is required.', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 512)
        throw new PumpPreflightError('Buy cost request is too large.', 413);
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof PumpPreflightError) throw error;
    throw new PumpPreflightError('Invalid buy cost request.', 400);
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return json({ error: 'Sign in to save buy costs.' }, 401);
    const url = new URL(request.url);
    if (request.headers.get('origin') !== url.origin)
      return json({ error: 'Use this site to save buy costs.' }, 403);
    if (
      !/^application\/json(?:\s*;.*)?$/i.test(
        request.headers.get('content-type') ?? '',
      )
    )
      return json({ error: 'Use a JSON buy cost review.' }, 415);
    if (url.searchParams.size)
      return json({ error: 'Unexpected buy cost parameters.' }, 400);
    const signal = deadline(request),
      value = (await body(request, signal)) as Record<string, unknown> | null;
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !==
        'approved,planSha256,policy,receiptId,reviewId' ||
      !launchEvidenceId(value.reviewId) ||
      !launchEvidenceId(value.receiptId) ||
      value.approved !== true ||
      value.policy !== 'reviewed-buy-shares-v1' ||
      typeof value.planSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.planSha256)
    )
      return json(
        { error: 'Approve the exact saved buy cost review and policy.' },
        400,
      );
    const result = await recordOwnedPumpPurchaseCosts(
      getD1(),
      user.userId,
      value.reviewId,
      {
        receiptId: value.receiptId,
        planSha256: value.planSha256,
        policy: value.policy,
        approved: true,
      },
      signal,
    );
    signal.throwIfAborted();
    return json(result);
  } catch (error) {
    return failure(error);
  }
}
