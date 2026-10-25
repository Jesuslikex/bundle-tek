import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import {
  AutoSellProfileStorageError,
  listAutoSellProfiles,
  readAutoSellProfile,
  saveAutoSellProfile,
} from '@/lib/auto-sell-profile-storage';
import { requireAutoSellProfileTerms } from '@/lib/auto-sell-profile';

export const dynamic = 'force-dynamic';
const authority = {
  signingAllowed: false,
  executionAllowed: false,
  automaticResumeAllowed: false,
} as const;
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
function failure(error: unknown, signal: AbortSignal) {
  if (signal.aborted)
    return json(
      {
        error:
          'Profile request interrupted. Check the original save ID before repeating a save.',
      },
      408,
    );
  return error instanceof AutoSellProfileStorageError
    ? json({ error: error.message }, error.status)
    : json({ error: 'Saved Auto Sell configurations are unavailable.' }, 503);
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json(
      { error: 'Sign in to read saved Auto Sell configurations.' },
      401,
    );
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
  const params = new URL(request.url).searchParams;
  if (
    [...params.keys()].some(
      (key) =>
        !['projectId', 'id', 'before'].includes(key) ||
        params.getAll(key).length !== 1,
    ) ||
    (params.has('id') && params.has('before'))
  )
    return json(
      { error: 'Choose one saved configuration or history page.' },
      400,
    );
  try {
    const db = getD1(),
      projectId = params.get('projectId') ?? '';
    return params.has('id')
      ? json({
          profile: await readAutoSellProfile(
            db,
            user.userId,
            projectId,
            params.get('id')!,
            signal,
          ),
          ...authority,
        })
      : json({
          ...(await listAutoSellProfiles(
            db,
            user.userId,
            projectId,
            params.get('before'),
            signal,
          )),
          ...authority,
        });
  } catch (error) {
    return failure(error, signal);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to save Auto Sell configurations.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin request required.' }, 403);
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get('content-type') ?? '',
    )
  )
    return json({ error: 'JSON required.' }, 415);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
  let body: Record<string, unknown>;
  try {
    body = await walletRequest(request, 263168, signal);
    if (
      Object.keys(body).sort().join(',') !==
        'action,expectedVersion,id,profileId,terms' ||
      body.action !== 'save' ||
      typeof body.id !== 'string' ||
      typeof body.profileId !== 'string' ||
      !Number.isSafeInteger(body.expectedVersion) ||
      (body.expectedVersion as number) < 0
    )
      return json(
        { error: 'Review exact configuration and version before saving.' },
        400,
      );
    body.terms = requireAutoSellProfileTerms(body.terms);
  } catch (error) {
    if (signal.aborted) return failure(error, signal);
    return json(
      {
        error:
          'Review a complete Auto Sell configuration within the 262144-byte profile capacity.',
      },
      400,
    );
  }
  try {
    const profile = await saveAutoSellProfile(
      getD1(),
      user.userId,
      {
        id: body.id as string,
        profileId: body.profileId as string,
        expectedVersion: body.expectedVersion as number,
        terms: requireAutoSellProfileTerms(body.terms),
      },
      signal,
    );
    return json({ profile, ...authority });
  } catch (error) {
    return failure(error, signal);
  }
}
