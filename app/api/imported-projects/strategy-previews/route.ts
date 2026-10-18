import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { capacityKeys } from '@/lib/strategy-review-capacity';
import { StrategyDraftError } from '@/lib/strategy-session-drafts';
import { UUID } from '@/lib/wallet-operation';
import { walletAddress } from '@/lib/wallet-workspace';
import {
  previewStrategyCandidate,
  type StrategyPreviewRequest,
} from '@/lib/strategy-unsigned-preview-server';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to preview this strategy.' }, 401);
  let input: StrategyPreviewRequest;
  try {
    if (
      !request.headers
        .get('content-type')
        ?.toLowerCase()
        .startsWith('application/json')
    )
      throw Error();
    const v = await walletRequest(request, 4000);
    capacityKeys(v, 'conditionPool,draftId,holdId,projectId,revision');
    if (
      ![v.projectId, v.draftId, v.holdId].every(
        (id) => typeof id === 'string' && UUID.test(id),
      ) ||
      !Number.isSafeInteger(v.revision) ||
      Number(v.revision) < 1 ||
      (v.conditionPool !== null &&
        (typeof v.conditionPool !== 'string' ||
          walletAddress(v.conditionPool, 'Solana') !== v.conditionPool))
    )
      throw Error();
    input = v as StrategyPreviewRequest;
  } catch {
    return json(
      {
        error:
          'Choose the exact saved draft, held review slot and condition pool.',
      },
      400,
    );
  }
  try {
    return json(
      await previewStrategyCandidate(
        getD1(),
        user.userId,
        input,
        request.signal,
      ),
    );
  } catch (e) {
    return e instanceof StrategyDraftError
      ? json({ error: e.message }, e.status)
      : json(
          {
            error:
              'Unsigned preview could not be verified. No review slots changed.',
          },
          502,
        );
  }
}
