import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { capacityKeys } from '@/lib/strategy-review-capacity';
import { StrategyDraftError } from '@/lib/strategy-session-drafts';
import {
  checkStrategyCandidate,
  type StrategyCheckRequest,
} from '@/lib/strategy-candidate-check-server';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to check strategy conditions.' }, 401);
  let body: StrategyCheckRequest;
  try {
    if (
      !request.headers
        .get('content-type')
        ?.toLowerCase()
        .startsWith('application/json')
    )
      throw Error();
    const input = await walletRequest(request, 4000);
    capacityKeys(input, 'draftId,holdId,projectId,revision');
    if (
      typeof input.projectId !== 'string' ||
      typeof input.draftId !== 'string' ||
      typeof input.holdId !== 'string' ||
      !Number.isSafeInteger(input.revision)
    )
      throw Error();
    body = input as StrategyCheckRequest;
  } catch {
    return json(
      { error: 'Choose the exact saved draft and held review slot.' },
      400,
    );
  }
  try {
    return json(
      await checkStrategyCandidate(getD1(), user.userId, body, request.signal),
    );
  } catch (e) {
    return e instanceof StrategyDraftError
      ? json({ error: e.message }, e.status)
      : json(
          {
            error:
              'Strategy condition check unavailable. No review slots changed.',
          },
          503,
        );
  }
}
