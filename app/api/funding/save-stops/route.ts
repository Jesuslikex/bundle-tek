import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import {
  fundingOwnerScope,
  FUNDING_OWNER_SCOPE_HEADER,
} from '@/lib/funding-owner-scope';
import { readFundingSaveStopRequest } from '@/lib/funding-save-stop';
import {
  FundingSaveStopStorageError,
  retainFundingSaveStop,
  readFundingSaveStop,
} from '@/lib/funding-save-stop-storage';

export const dynamic = 'force-dynamic';
const json = (value: unknown, status: number, ownerScope?: string) =>
  Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(ownerScope ? { [FUNDING_OWNER_SCOPE_HEADER]: ownerScope } : {}),
    },
  });
function failure(error: unknown, signal: AbortSignal, scope: string) {
  if (signal.aborted)
    return json(
      {
        error:
          'The draft-save stop request was interrupted. Check its original stop ID; no transfer cancellation is implied.',
      },
      408,
      scope,
    );
  return error instanceof FundingSaveStopStorageError
    ? json({ error: error.message }, error.status, scope)
    : json(
        {
          error:
            'Draft-save stop storage is unavailable. Keep the original recovery record and check that exact stop ID.',
        },
        503,
        scope,
      );
}

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json(
      { error: 'Sign in to inspect the original draft-save stop.' },
      401,
    );
  const scope = fundingOwnerScope(user.userId);
  if (request.headers.get(FUNDING_OWNER_SCOPE_HEADER) !== scope)
    return json(
      {
        error:
          'The signed-in funding account changed. Keep its recovery record.',
      },
      403,
      scope,
    );
  const params = new URL(request.url).searchParams;
  if (
    [...params.keys()].some((key) => key !== 'stopId') ||
    params.getAll('stopId').length !== 1
  )
    return json(
      { error: 'Choose one original draft-save stop ID.' },
      400,
      scope,
    );
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
  try {
    const receipt = await readFundingSaveStop(
      getD1(),
      user.userId,
      params.get('stopId')!,
      signal,
    );
    return receipt
      ? json({ receipt }, 200, scope)
      : json(
          {
            error:
              'The original draft-save stop is not visible yet. Keep its recovery record.',
          },
          404,
          scope,
        );
  } catch (error) {
    return failure(error, signal, scope);
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json(
      { error: 'Sign in before stopping an original draft-save attempt.' },
      401,
    );
  const scope = fundingOwnerScope(user.userId);
  if (request.headers.get(FUNDING_OWNER_SCOPE_HEADER) !== scope)
    return json(
      {
        error:
          'The signed-in funding account changed. Keep its recovery record.',
      },
      403,
      scope,
    );
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin approval is required.' }, 403, scope);
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get('content-type') ?? '',
    )
  )
    return json({ error: 'JSON required.' }, 415, scope);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
  let body: ReturnType<typeof readFundingSaveStopRequest>;
  try {
    body = readFundingSaveStopRequest(
      await walletRequest(request, 2048, signal),
    );
  } catch (error) {
    if (signal.aborted) return failure(error, signal, scope);
    return json(
      {
        error:
          'Review the exact original draft-save reference and separately approve stopping that draft attempt.',
      },
      400,
      scope,
    );
  }
  if (body.reminder.ownerScope !== scope)
    return json(
      { error: 'The original save belongs to a different signed-in account.' },
      403,
      scope,
    );
  try {
    const receipt = await retainFundingSaveStop(
      getD1(),
      user.userId,
      body,
      signal,
    );
    return json({ receipt }, 200, scope);
  } catch (error) {
    return failure(error, signal, scope);
  }
}
