import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import {
  StrategyDraftError,
  listStrategyDrafts,
  saveStrategyDraft,
  archiveStrategyDraft,
} from '@/lib/strategy-session-drafts';
import type { StrategySessionInput } from '@/lib/strategy-session-plan';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const failure = (e: unknown) =>
  e instanceof StrategyDraftError
    ? json({ error: e.message }, e.status)
    : json(
        { error: 'Strategy draft storage unavailable. No trades started.' },
        503,
      );
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view strategy drafts.' }, 401);
  const params = new URL(request.url).searchParams;
  if (
    [...params.keys()].some(
      (k) => !['projectId', 'archived', 'before'].includes(k),
    ) ||
    [...params.keys()].some((k) => params.getAll(k).length !== 1) ||
    !['0', '1'].includes(params.get('archived') ?? '0')
  )
    return json({ error: 'Choose a draft page.' }, 400);
  try {
    return json(
      await listStrategyDrafts(
        getD1(),
        user.userId,
        params.get('projectId') ?? '',
        params.get('archived') === '1',
        params.get('before') ?? undefined,
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to save strategy drafts.' }, 401);
  let body: Record<string, unknown>;
  try {
    if (
      !request.headers
        .get('content-type')
        ?.toLowerCase()
        .startsWith('application/json')
    )
      throw Error();
    body = await walletRequest(request, 24000);
    const keys = Object.keys(body).sort().join(',');
    if (
      body.action === 'save' &&
      keys === 'action,id,input' &&
      typeof body.id === 'string'
    ) {
      if (
        !body.input ||
        typeof body.input !== 'object' ||
        Array.isArray(body.input)
      )
        throw Error();
    } else if (
      !(
        body.action === 'archive' &&
        keys === 'action,archived,id,projectId,revision' &&
        typeof body.id === 'string' &&
        typeof body.projectId === 'string' &&
        typeof body.archived === 'boolean' &&
        Number.isSafeInteger(body.revision)
      )
    )
      throw Error();
  } catch {
    return json({ error: 'Review exact strategy draft terms.' }, 400);
  }
  try {
    const draft =
      body.action === 'save'
        ? await saveStrategyDraft(
            getD1(),
            user.userId,
            body.id as string,
            body.input as StrategySessionInput,
          )
        : await archiveStrategyDraft(
            getD1(),
            user.userId,
            body.projectId as string,
            body.id as string,
            body.revision as number,
            body.archived as boolean,
          );
    return json({ draft, planningOnly: true, executionAllowed: false });
  } catch (e) {
    return failure(e);
  }
}
