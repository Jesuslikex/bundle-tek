import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { StrategyDraftError } from '@/lib/strategy-session-drafts';
import {
  capacityKeys,
  type ReviewCapacityEvent,
} from '@/lib/strategy-review-capacity';
import {
  changeStrategyReviewCapacity,
  readStrategyReviewCapacity,
} from '@/lib/strategy-review-capacity-server';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const failure = (e: unknown) =>
  e instanceof StrategyDraftError
    ? json({ error: e.message }, e.status)
    : json(
        {
          error:
            'Review capacity storage unavailable. Reload to recover the last saved state. No trades started.',
        },
        503,
      );
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to review strategy capacity.' }, 401);
  const p = new URL(request.url).searchParams;
  if ([...p.keys()].sort().join(',') !== 'draftId,projectId')
    return json({ error: 'Choose one saved draft.' }, 400);
  try {
    return json(
      await readStrategyReviewCapacity(
        getD1(),
        user.userId,
        p.get('projectId') ?? '',
        p.get('draftId') ?? '',
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to review strategy capacity.' }, 401);
  let body: Record<string, unknown>;
  try {
    if (
      !request.headers
        .get('content-type')
        ?.toLowerCase()
        .startsWith('application/json')
    )
      throw Error();
    body = await walletRequest(request, 12000);
    capacityKeys(body, 'draftId,event,projectId,revision');
    if (
      typeof body.projectId !== 'string' ||
      typeof body.draftId !== 'string' ||
      !Number.isSafeInteger(body.revision)
    )
      throw Error();
    if (
      !body.event ||
      typeof body.event !== 'object' ||
      Array.isArray(body.event)
    )
      throw Error();
    const event = body.event as Record<string, unknown>;
    if (!['hold', 'release'].includes(event.kind as string)) throw Error();
    capacityKeys(
      event,
      event.kind === 'hold' ? 'candidate,id,kind,strategyId' : 'id,kind',
    );
    if (
      typeof event.id !== 'string' ||
      (event.kind === 'hold' &&
        (typeof event.strategyId !== 'string' ||
          !Number.isSafeInteger(event.candidate)))
    )
      throw Error();
  } catch {
    return json(
      { error: 'Review the exact saved draft and capacity request.' },
      400,
    );
  }
  try {
    return json(
      await changeStrategyReviewCapacity(
        getD1(),
        user.userId,
        body.projectId as string,
        body.draftId as string,
        body.revision as number,
        body.event as ReviewCapacityEvent,
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
