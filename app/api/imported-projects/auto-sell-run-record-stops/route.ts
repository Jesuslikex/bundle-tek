import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import {
  autoSellRunEnrollmentOwnerScope,
  autoSellRunRecordStopAuthority,
} from '@/lib/auto-sell-run-record-stop';
import {
  autoSellRunRecordStopReady,
  AutoSellRunRecordStopStorageError,
  readOwnedAutoSellRunRecordStop,
  stopOwnedAutoSellRunRecord,
} from '@/lib/auto-sell-run-record-stop-storage';
export const dynamic = 'force-dynamic';
const json = (value: Record<string, unknown>, status = 200) =>
  Response.json(
    { ...value, ...autoSellRunRecordStopAuthority },
    { status, headers: { 'cache-control': 'no-store' } },
  );
function failure(error: unknown, signal: AbortSignal) {
  return signal.aborted
    ? json(
        {
          error:
            'Waiting stopped. Retain the original record request and inspect its stop receipt.',
        },
        408,
      )
    : error instanceof AutoSellRunRecordStopStorageError
      ? json({ error: error.message }, error.status)
      : json(
          {
            error:
              'Original record-stop storage is unavailable. Keep the original request identity.',
          },
          503,
        );
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json(
      { error: 'Sign in to inspect the original record request.' },
      401,
    );
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
  const params = new URL(request.url).searchParams;
  if (
    [...params.keys()].length !== 1 ||
    [...params.keys()].some(
      (k) =>
        !['capability', 'runId'].includes(k) || params.getAll(k).length !== 1,
    ) ||
    (params.has('capability') && params.get('capability') !== '1')
  )
    return json(
      { error: 'Choose one original run ID or the capability check.' },
      400,
    );
  try {
    const ownerScope = await autoSellRunEnrollmentOwnerScope(user.userId);
    if (params.has('capability')) {
      await autoSellRunRecordStopReady(getD1(), signal);
      return json({ ownerScope, recordStopSupported: true });
    }
    return json({
      ownerScope,
      ...(await readOwnedAutoSellRunRecordStop(
        getD1(),
        user.userId,
        params.get('runId')!,
        signal,
      )),
    });
  } catch (error) {
    return failure(error, signal);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json(
      { error: 'Sign in before stopping the original record request.' },
      401,
    );
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin approval is required.' }, 403);
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get('content-type') ?? '',
    )
  )
    return json({ error: 'JSON approval is required.' }, 415);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
  let input: unknown;
  try {
    input = await walletRequest(request, 2048, signal);
  } catch {
    return signal.aborted
      ? failure(null, signal)
      : json(
          {
            error:
              'Review the exact original request within the 2048-byte limit.',
          },
          400,
        );
  }
  try {
    return json({
      ownerScope: await autoSellRunEnrollmentOwnerScope(user.userId),
      ...(await stopOwnedAutoSellRunRecord(
        getD1(),
        user.userId,
        input,
        signal,
      )),
    });
  } catch (error) {
    return failure(error, signal);
  }
}
