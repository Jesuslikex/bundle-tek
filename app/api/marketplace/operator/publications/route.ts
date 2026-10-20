import { z } from 'zod';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { isMarketplaceOperator } from '@/lib/marketplace-operator-policy';
import { operatorDraftId } from '@/lib/marketplace-operator-draft-view';
import {
  publicationRequest,
  withdrawalRequest,
} from '@/lib/marketplace-publication';
import {
  previewPublication,
  publishListing,
  readPublication,
  readPublicationForDraft,
  withdrawListing,
} from '@/lib/marketplace-publication-storage';
import { OperatorDraftStorageError } from '@/lib/marketplace-operator-draft-storage';
import { walletRequest } from '@/lib/wallet-request';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const actions = z.discriminatedUnion('action', [
  z.object({ action: z.literal('review'), draftId: operatorDraftId }).strict(),
  publicationRequest.extend({ action: z.literal('publish') }),
  withdrawalRequest.extend({ action: z.literal('withdraw') }),
]);
async function auth() {
  const user = await getChatGPTUser();
  return !user
    ? json({ error: 'Sign in to manage Bundle listings.' }, 401)
    : !isMarketplaceOperator(user.userId)
      ? json(
          { error: 'Only configured Bundle operators can manage listings.' },
          403,
        )
      : user;
}
function failure(error: unknown, request: Request) {
  return request.signal.aborted
    ? json(
        {
          error:
            'Stopped waiting. Recover the same publication ID before another write.',
        },
        408,
      )
    : error instanceof OperatorDraftStorageError
      ? json({ error: error.message }, error.status)
      : json(
          {
            error:
              'Marketplace publication unavailable. Recover the same publication ID before another write.',
          },
          503,
        );
}
export async function GET(request: Request) {
  try {
    const user = await auth();
    if (user instanceof Response) return user;
    const params = new URL(request.url).searchParams,
      id = params.get('id'),
      draftId = params.get('draftId');
    if (
      [...params.keys()].length !== 1 ||
      (id === null && draftId === null) ||
      !operatorDraftId.safeParse(id ?? draftId).success
    )
      return json({ error: 'Choose one publication ID.' }, 400);
    const publication =
      id !== null
        ? await readPublication(getD1(), user.userId, id, request.signal)
        : await readPublicationForDraft(
            getD1(),
            user.userId,
            draftId!,
            request.signal,
          );
    return publication
      ? json({ publication })
      : json({ error: 'Publication not found for this operator.' }, 404);
  } catch (error) {
    return failure(error, request);
  }
}
export async function POST(request: Request) {
  try {
    const user = await auth();
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
    let input;
    try {
      input = actions.parse(await walletRequest(request, 2048));
    } catch (error) {
      const large =
        error instanceof Error && error.message === 'Wallet request too large.';
      return json(
        {
          error: large
            ? 'Request too large.'
            : 'Choose the exact reviewed operation and its separate acknowledgement.',
        },
        large ? 413 : 400,
      );
    }
    const { action, ...payload } = input;
    if (action === 'review') {
      const result = await previewPublication(
        getD1(),
        user.userId,
        input.draftId,
        request.signal,
      );
      return json({ preview: result.preview });
    }
    if (action === 'publish')
      return json({
        publication: await publishListing(
          getD1(),
          user.userId,
          publicationRequest.parse(payload),
          request.signal,
        ),
      });
    return json({
      publication: await withdrawListing(
        getD1(),
        user.userId,
        payload,
        request.signal,
      ),
    });
  } catch (error) {
    return failure(error, request);
  }
}
