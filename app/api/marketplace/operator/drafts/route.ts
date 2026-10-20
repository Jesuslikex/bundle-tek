import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { isMarketplaceOperator } from '@/lib/marketplace-operator-policy';
import {
  operatorDraftId,
  operatorDraftSave,
} from '@/lib/marketplace-operator-draft-view';
import {
  readOperatorDraft,
  saveOperatorDraft,
  OperatorDraftStorageError,
} from '@/lib/marketplace-operator-draft-storage';
import { walletRequest } from '@/lib/wallet-request';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
async function authorized() {
  const user = await getChatGPTUser();
  return !user
    ? json({ error: 'Sign in to use listing drafts.' }, 401)
    : !isMarketplaceOperator(user.userId)
      ? json(
          { error: 'Only configured Bundle operators can use listing drafts.' },
          403,
        )
      : user;
}
function failure(error: unknown, request: Request) {
  return request.signal.aborted
    ? json(
        {
          error:
            'Stopped waiting. Recover the same draft ID before saving again.',
        },
        408,
      )
    : error instanceof OperatorDraftStorageError
      ? json({ error: error.message }, error.status)
      : json(
          {
            error:
              'Listing draft unavailable. Recover the same draft ID before saving again.',
          },
          503,
        );
}
export async function GET(request: Request) {
  try {
    const user = await authorized();
    if (user instanceof Response) return user;
    const params = new URL(request.url).searchParams,
      id = params.get('id');
    if (
      [...params.keys()].length !== 1 ||
      !operatorDraftId.safeParse(id).success
    )
      return json({ error: 'Choose one saved draft ID.' }, 400);
    const draft = await readOperatorDraft(
      getD1(),
      user.userId,
      id!,
      request.signal,
    );
    return draft
      ? json({ draft })
      : json({ error: 'Saved draft not found for this account.' }, 404);
  } catch (error) {
    return failure(error, request);
  }
}
export async function POST(request: Request) {
  try {
    const user = await authorized();
    if (user instanceof Response) return user;
    if (request.headers.get('origin') !== new URL(request.url).origin)
      return json({ error: 'Same-origin request required.' }, 403);
    if (
      request.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase() !== 'application/json'
    )
      return json({ error: 'JSON required.' }, 415);
    let selection;
    try {
      selection = operatorDraftSave.parse(await walletRequest(request, 2048));
    } catch (error) {
      const large =
        error instanceof Error && error.message === 'Wallet request too large.';
      return json(
        {
          error: large
            ? 'Request too large.'
            : 'Acknowledge saving the exact reviewed unpublished draft.',
        },
        large ? 413 : 400,
      );
    }
    const draft = await saveOperatorDraft(
      getD1(),
      user.userId,
      selection,
      request.signal,
    );
    return json({ draft });
  } catch (error) {
    return failure(error, request);
  }
}
