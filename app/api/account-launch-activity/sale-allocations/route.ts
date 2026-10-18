import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { ImportedSaleEvidenceError } from '@/lib/imported-sale-evidence-service';
import {
  LAUNCH_SALE_POLICY,
  LaunchSaleAllocationError,
} from '@/lib/launch-sale-allocation';
import {
  readOwnedLaunchSaleAllocation,
  recordOwnedLaunchSaleAllocation,
  reviewOwnedLaunchSaleAllocation,
  type LaunchSaleSelection,
} from '@/lib/launch-sale-allocation-service';
import { PumpPreflightError } from '@/lib/owned-pump-preflight';
import { UUID } from '@/lib/wallet-operation';
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
            'The request stopped or timed out. Reload the saved sale before retrying the same save.',
        },
        408,
      )
    : error instanceof LaunchSaleAllocationError ||
        error instanceof PumpPreflightError ||
        error instanceof ImportedSaleEvidenceError
      ? json({ error: error.message }, error.status)
      : json(
          {
            error:
              'Sale acquisitions could not be verified. Reload the saved sale before retrying.',
          },
          503,
        );
const deadline = (request: Request) =>
  AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]);
/** Saved-only read of one sale's launch acquisitions. No RPC. */
export async function GET(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user)
      return json({ error: 'Sign in to review sale acquisitions.' }, 401);
    const params = new URL(request.url).searchParams,
      id = params.get('saleReceiptId');
    if (
      params.size !== 1 ||
      params.getAll('saleReceiptId').length !== 1 ||
      !id ||
      !UUID.test(id)
    )
      return json({ error: 'Select one retained sale.' }, 400);
    const signal = deadline(request);
    const result = await readOwnedLaunchSaleAllocation(
      getD1(),
      user.userId,
      id,
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
    throw new LaunchSaleAllocationError(
      'A sale acquisition review is required.',
      400,
    );
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
      if (size > 4096)
        throw new LaunchSaleAllocationError(
          'Sale acquisition request is too large.',
          413,
        );
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
    if (error instanceof LaunchSaleAllocationError) throw error;
    throw new LaunchSaleAllocationError(
      'Invalid sale acquisition request.',
      400,
    );
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
const keys = (v: object) => Object.keys(v).sort().join(',');
/** review: preview only. record: explicit approval of the exact reviewed hash. */
export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user)
      return json({ error: 'Sign in to save sale acquisitions.' }, 401);
    const url = new URL(request.url);
    if (request.headers.get('origin') !== url.origin)
      return json({ error: 'Use this site to save sale acquisitions.' }, 403);
    if (
      !/^application\/json(?:\s*;.*)?$/i.test(
        request.headers.get('content-type') ?? '',
      )
    )
      return json({ error: 'Use a JSON sale acquisition review.' }, 415);
    if (url.searchParams.size)
      return json({ error: 'Unexpected sale acquisition parameters.' }, 400);
    const signal = deadline(request),
      v = (await body(request, signal)) as Record<string, unknown> | null;
    const shaped =
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      typeof v.saleReceiptId === 'string' &&
      UUID.test(v.saleReceiptId) &&
      Array.isArray(v.allocations);
    if (
      shaped &&
      v.action === 'review' &&
      keys(v) === 'action,allocations,saleReceiptId'
    ) {
      const plan = await reviewOwnedLaunchSaleAllocation(
        getD1(),
        user.userId,
        v.saleReceiptId as string,
        v.allocations as LaunchSaleSelection[],
        signal,
      );
      signal.throwIfAborted();
      return json({ plan, executionAllowed: false, profitCalculated: false });
    }
    if (
      shaped &&
      v.action === 'record' &&
      keys(v) ===
        'action,allocations,approved,planSha256,policy,saleReceiptId' &&
      v.approved === true &&
      v.policy === LAUNCH_SALE_POLICY &&
      typeof v.planSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(v.planSha256)
    ) {
      const result = await recordOwnedLaunchSaleAllocation(
        getD1(),
        user.userId,
        v.saleReceiptId as string,
        v.allocations as LaunchSaleSelection[],
        {
          approved: true,
          policy: LAUNCH_SALE_POLICY,
          planSha256: v.planSha256,
        },
        signal,
      );
      signal.throwIfAborted();
      return json(result);
    }
    return json(
      { error: 'Review, then approve the exact sale acquisition plan.' },
      400,
    );
  } catch (error) {
    return failure(error);
  }
}
