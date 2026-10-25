import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import {
  autoSellRunId,
  readAutoSellRunAttemptInput,
} from '@/lib/auto-sell-run';
import {
  AutoSellRunStorageError,
  createOwnedAutoSellRun,
  readOwnedAutoSellAttempts,
  listOwnedAutoSellRuns,
  reserveOwnedAutoSellAttempt,
  stopOwnedAutoSellRun,
} from '@/lib/auto-sell-run-storage';

export const dynamic = 'force-dynamic';
const authority = {
  signingAllowed: false,
  executionAllowed: false,
  automaticResumeAllowed: false,
} as const;
const json = (value: Record<string, unknown>, status = 200) => {
  const text = JSON.stringify({ ...value, ...authority });
  if (new TextEncoder().encode(text).byteLength > 1048576)
    return Response.json(
      {
        error:
          'This journal response exceeds the complete recovery capacity. Keep the original IDs; no partial progress was returned.',
        ...authority,
      },
      { status: 409, headers: { 'cache-control': 'no-store' } },
    );
  return new Response(text, {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
};
function failure(error: unknown, signal: AbortSignal) {
  if (signal.aborted)
    return json(
      {
        error:
          'Journal waiting stopped. Keep the original run and attempt IDs. No allowance was released.',
      },
      408,
    );
  return error instanceof AutoSellRunStorageError
    ? json({ error: error.message }, error.status === 499 ? 408 : error.status)
    : json(
        {
          error:
            'Auto Sell run history is unavailable. Keep the original run and attempt IDs.',
        },
        503,
      );
}
function keys(body: Record<string, unknown>, expected: string[]) {
  if (Object.keys(body).sort().join(',') !== expected.sort().join(','))
    throw new SyntaxError('Invalid journal request');
}
function savedIndexId(value: unknown) {
  try {
    return autoSellRunId(value);
  } catch {
    throw new AutoSellRunStorageError(
      'Choose a complete original run or project ID.',
      400,
    );
  }
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to inspect original Auto Sell runs.' }, 401);
  const params = new URL(request.url).searchParams;
  if (params.has('index')) {
    if (
      [...params.keys()].some(
        (key) =>
          !['projectId', 'index', 'beforeId', 'beforeAt'].includes(key) ||
          params.getAll(key).length !== 1,
      ) ||
      params.get('index') !== '1' ||
      !params.has('projectId') ||
      params.has('beforeId') !== params.has('beforeAt')
    )
      return json(
        {
          error:
            'Choose one owned project and complete saved-run index cursor.',
        },
        400,
      );
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(20000),
    ]);
    try {
      const projectId = savedIndexId(params.get('projectId'));
      const result = await listOwnedAutoSellRuns(
        getD1(),
        user.userId,
        projectId,
        params.has('beforeId')
          ? { id: params.get('beforeId')!, createdAt: params.get('beforeAt')! }
          : null,
        signal,
      );
      return json({ projectId, ...result });
    } catch (error) {
      return failure(error, signal);
    }
  }
  if (params.has('attempts') || params.has('beforeSequence')) {
    const cursor = params.get('beforeSequence');
    if (
      [...params.keys()].some(
        (key) =>
          !['runId', 'attempts', 'beforeSequence'].includes(key) ||
          params.getAll(key).length !== 1,
      ) ||
      params.get('attempts') !== '1' ||
      !params.has('runId') ||
      (cursor !== null &&
        (!/^[1-9][0-9]{0,3}$/.test(cursor) || Number(cursor) > 1000))
    )
      return json(
        { error: 'Choose one original run and complete attempt cursor.' },
        400,
      );
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(20000),
    ]);
    try {
      const runId = savedIndexId(params.get('runId'));
      const history = await readOwnedAutoSellAttempts(
        getD1(),
        user.userId,
        runId,
        signal,
      );
      const before = cursor === null ? null : Number(cursor);
      if (
        before !== null &&
        !history.attempts.some((a) => a.sequence === before)
      )
        return json(
          { error: 'Choose an existing attempt sequence from this owned run.' },
          400,
        );
      const candidates = history.attempts
        .filter((a) => before === null || a.sequence < before)
        .reverse();
      const page = candidates.slice(0, 20),
        started = new Set(history.preparationStarts.map((s) => s.attemptId));
      const terms = history.run.profile.terms;
      return json({
        runId,
        runSha256: history.run.sha256,
        context: {
          projectId: terms.projectId,
          projectRevision: terms.projectRevision,
          mint: terms.token.mint,
          decimals: terms.token.decimals,
        },
        accounting: {
          sequence: history.accounting.sequence,
          headSha256: history.accounting.headSha256,
          accountedRaw: history.accounting.accountedRaw,
        },
        stopped: history.stopped,
        attempts: page.map((a) => ({
          id: a.id,
          sequence: a.sequence,
          attemptSha256: a.sha256,
          strategyId: a.strategyId,
          wallet: a.wallet,
          walletRevision: a.walletRevision,
          inputRaw: a.inputRaw,
          preparationId: a.preparationId,
          reservedAt: a.reservedAt,
          preparationStarted: started.has(a.id),
        })),
        nextBeforeSequence:
          candidates.length > 20 ? page.at(-1)!.sequence : null,
      });
    } catch (error) {
      return failure(error, signal);
    }
  }
  if (
    [...params.keys()].some(
      (key) =>
        !['projectId', 'runId', 'attemptId', 'beforeId', 'beforeAt'].includes(
          key,
        ) || params.getAll(key).length !== 1,
    )
  )
    return json(
      { error: 'Choose one original run or journal history page.' },
      400,
    );
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
  try {
    if (params.has('attemptId')) autoSellRunId(params.get('attemptId'));
  } catch {
    return json({ error: 'Choose a complete original attempt ID.' }, 400);
  }
  try {
    if (params.has('runId')) {
      if (
        params.has('projectId') ||
        params.has('beforeId') ||
        params.has('beforeAt')
      )
        return json({ error: 'Choose one original run.' }, 400);
      const history = await readOwnedAutoSellAttempts(
        getD1(),
        user.userId,
        params.get('runId')!,
        signal,
      );
      if (params.has('attemptId')) {
        const attempt = history.attempts.find(
          (a) => a.id === params.get('attemptId'),
        );
        return attempt
          ? json({ attempt })
          : json({ error: 'Original Auto Sell attempt unavailable.' }, 404);
      }
      const a = history.accounting;
      return json({
        run: history.run,
        accounting: {
          sequence: a.sequence,
          headSha256: a.headSha256,
          accountedRaw: a.accountedRaw,
          strategies: a.strategies.map((s) => ({
            id: s.id,
            accountedRaw: s.accountedRaw,
            claimedKeyCount: s.claimedKeys.length,
            nextDcaIndex: s.nextDcaIndex,
            nextDcaAt: s.nextDcaAt,
          })),
        },
        preparationStarts: history.preparationStarts,
        stopped: history.stopped,
        stop: history.stop,
      });
    }
    if (
      !params.has('projectId') ||
      params.has('attemptId') ||
      params.has('beforeId') !== params.has('beforeAt')
    )
      return json(
        { error: 'Choose a project and complete journal cursor.' },
        400,
      );
    return json(
      await listOwnedAutoSellRuns(
        getD1(),
        user.userId,
        params.get('projectId')!,
        params.has('beforeId')
          ? { id: params.get('beforeId')!, createdAt: params.get('beforeAt')! }
          : null,
        signal,
      ),
    );
  } catch (error) {
    return failure(error, signal);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json(
      { error: 'Sign in before recording an Auto Sell run or attempt.' },
      401,
    );
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin journal approval is required.' }, 403);
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get('content-type') ?? '',
    )
  )
    return json({ error: 'JSON required.' }, 415);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
  let body: Record<string, unknown>;
  try {
    body = await walletRequest(request, 32768, signal);
  } catch {
    return signal.aborted
      ? failure(null, signal)
      : json(
          {
            error:
              'Review a complete journal request within the 32768-byte capacity.',
          },
          400,
        );
  }
  try {
    if (body.action === 'create') {
      keys(body, [
        'action',
        'id',
        'projectId',
        'profileSaveId',
        'profileSha256',
        'consent',
      ]);
      if (
        body.consent !== 'record-auto-sell-run-v1' ||
        !['id', 'projectId', 'profileSaveId', 'profileSha256'].every(
          (k) => typeof body[k] === 'string',
        )
      )
        return json(
          {
            error:
              'Review the exact saved configuration before recording a run.',
          },
          400,
        );
      return json({
        run: await createOwnedAutoSellRun(
          getD1(),
          user.userId,
          {
            id: body.id as string,
            projectId: body.projectId as string,
            profileSaveId: body.profileSaveId as string,
            profileSha256: body.profileSha256 as string,
            consent: 'record-auto-sell-run-v1',
          },
          signal,
        ),
      });
    }
    if (body.action === 'reserve') {
      keys(body, ['action', 'attempt']);
      let input;
      try {
        input = readAutoSellRunAttemptInput(body.attempt);
      } catch {
        return json(
          {
            error:
              'Review the exact original run, sequence and occurrence before reserving an attempt.',
          },
          400,
        );
      }
      return json({
        attempt: await reserveOwnedAutoSellAttempt(
          getD1(),
          user.userId,
          input,
          signal,
        ),
      });
    }
    if (body.action === 'stop') {
      keys(body, ['action', 'id', 'runId', 'runSha256', 'consent']);
      if (
        body.consent !== 'stop-auto-sell-run-v1' ||
        !['id', 'runId', 'runSha256'].every((k) => typeof body[k] === 'string')
      )
        return json(
          {
            error:
              'Separately approve stopping this exact run. Existing exposure remains held.',
          },
          400,
        );
      return json({
        stop: await stopOwnedAutoSellRun(
          getD1(),
          user.userId,
          {
            id: body.id as string,
            runId: body.runId as string,
            runSha256: body.runSha256 as string,
          },
          signal,
        ),
      });
    }
    return json({ error: 'Choose a supported journal action.' }, 400);
  } catch (error) {
    if (error instanceof SyntaxError)
      return json(
        {
          error:
            'Review the exact journal fields; additional authority or progress claims are not accepted.',
        },
        400,
      );
    if (error instanceof AutoSellRunStorageError || signal.aborted)
      return failure(error, signal);
    return json(
      {
        error:
          'The journal request was not confirmed. Keep the original run and attempt IDs.',
      },
      503,
    );
  }
}
