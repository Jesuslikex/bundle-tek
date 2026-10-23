import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  CounterBudgetError,
  CounterBudgetRecoveryError,
  CounterBudgetSaveRefusalError,
  type CounterBudgetRequest,
  AutoBuyBudgetError,
  counterBudgetRequest,
  reviewOwnedCounterBudget,
  saveOwnedCounterBudget,
  recoverOwnedCounterBudget,
  recoverExistingCounterBudgetSave,
} from '@/lib/counter-owned-budget';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(status === 429 ? { 'retry-after': '15' } : {}),
    },
  });
async function body(request: Request) {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3000)]),
    reader = request.body?.getReader();
  if (!reader) throw new CounterBudgetError('JSON request required.', 400);
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      void reader.cancel().catch(() => {});
      reject(
        new CounterBudgetError(
          'Counter budget metadata request timed out or was cancelled.',
          408,
        ),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  void interrupted.catch(() => {});
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0,
      text = '';
    while (true) {
      signal.throwIfAborted();
      const chunk = await Promise.race([reader.read(), interrupted]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2048)
        throw new CounterBudgetError(
          'Counter budget metadata request is too large.',
          413,
        );
      text += decoder.decode(chunk.value, { stream: true });
    }
    signal.throwIfAborted();
    text += decoder.decode();
    return counterBudgetRequest(JSON.parse(text));
  } catch (error) {
    if (error instanceof CounterBudgetError) throw error;
    if (signal.aborted)
      throw new CounterBudgetError(
        'Counter budget metadata request timed out or was cancelled.',
        408,
      );
    throw new CounterBudgetError(
      'Use valid UTF-8 JSON for this Counter budget metadata request.',
      400,
    );
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
  }
}

function failure(error: unknown, signal: AbortSignal) {
  if (error instanceof CounterBudgetSaveRefusalError)
    return json(
      {
        format: error.format,
        originalId: error.originalId,
        reviewSha256: error.reviewSha256,
        scope: error.scope,
        priorSaveOutcomeVerified: false,
        writerAttempted: false,
        recoveryRequired: false,
        error: error.message,
      },
      error.status,
    );
  if (error instanceof CounterBudgetRecoveryError)
    return json(
      {
        format: error.format,
        error: error.message,
        originalId: error.originalId,
        writerAttempted: error.writerAttempted,
        recoveryRequired: true,
      },
      error.status,
    );
  if (signal.aborted)
    return json(
      { error: 'Counter metadata request cancelled or timed out.' },
      408,
    );
  if (
    error instanceof CounterBudgetError ||
    error instanceof AutoBuyBudgetError
  )
    return json({ error: error.message }, error.status);
  return json(
    {
      error:
        'Owned Counter metadata is unavailable. No trading authority is created.',
    },
    502,
  );
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to review owned budget metadata.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin request required.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  if (new URL(request.url).searchParams.size)
    return json({ error: 'Unexpected query parameters.' }, 400);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
  let input: CounterBudgetRequest | undefined;
  let saveEntered = false;
  try {
    input = await body(request);
    signal.throwIfAborted();
    const db = getD1();
    if (input.action === 'review')
      return json({
        review: await reviewOwnedCounterBudget(db, user.userId, input, signal),
      });
    const existing = await recoverExistingCounterBudgetSave(
      db,
      user.userId,
      input,
      signal,
    );
    if (existing) return json({ saved: existing });
    const now = Date.now(),
      gate = await db
        .prepare(
          'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
        )
        .bind(user.userId, now + 15000, now)
        .run();
    signal.throwIfAborted();
    if (!gate.meta.changes)
      throw new CounterBudgetError(
        'Wait 15 seconds between metadata saves or provider previews.',
        429,
      );
    saveEntered = true;
    return json({
      saved: await saveOwnedCounterBudget(db, user.userId, input, signal),
    });
  } catch (error) {
    if (error instanceof CounterBudgetRecoveryError)
      return failure(error, signal);
    if (input?.action === 'save' && !saveEntered)
      return failure(
        new CounterBudgetSaveRefusalError(
          input.budgetId,
          input.reviewSha256,
          signal.aborted
            ? 'This request cancelled before attempting its metadata writer; earlier save outcomes are not verified.'
            : error instanceof CounterBudgetError ||
                error instanceof AutoBuyBudgetError
              ? error.message
              : 'Metadata save could not begin.',
          signal.aborted
            ? 408
            : error instanceof CounterBudgetError ||
                error instanceof AutoBuyBudgetError
              ? error.status
              : 502,
        ),
        signal,
      );
    return failure(error, signal);
  }
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to recover original budget history.' }, 401);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin request rejected.' }, 403);
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].length !== 1 || !params.has('id'))
    return json({ error: 'Choose only the original budget ID.' }, 400);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)]);
  try {
    return json({
      saved: await recoverOwnedCounterBudget(
        getD1(),
        user.userId,
        params.get('id')!,
        signal,
      ),
    });
  } catch (error) {
    return failure(error, signal);
  }
}
