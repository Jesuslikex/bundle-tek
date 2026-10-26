import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { autoSellRunEnrollmentOwnerScope } from '@/lib/auto-sell-run-record-stop';
import { AUTO_SELL_RUN_PROGRESS_MAX_BYTES } from '@/lib/auto-sell-run-progress';
import {
  AutoSellRunProgressStorageError,
  autoSellRunProgressCapacityMessage,
  readOwnedAutoSellRunProgress,
} from '@/lib/auto-sell-run-progress-storage';
export const dynamic = 'force-dynamic';
const authority = {
  signingAllowed: false,
  executionAllowed: false,
  automaticResumeAllowed: false,
  allowanceReleased: false,
} as const;
const json = (value: Record<string, unknown>, status = 200) =>
  Response.json(
    { ...value, ...authority },
    { status, headers: { 'cache-control': 'no-store' } },
  );
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to inspect original saved progress.' }, 401);
  const params = new URL(request.url).searchParams;
  if (
    [...params.keys()].length !== 2 ||
    !params.has('projectId') ||
    !params.has('runId') ||
    [...params.keys()].some(
      (k) =>
        !['projectId', 'runId'].includes(k) || params.getAll(k).length !== 1,
    )
  )
    return json({ error: 'Choose exactly one original project and run.' }, 400);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
  try {
    const evidence = await readOwnedAutoSellRunProgress(
      getD1(),
      user.userId,
      params.get('projectId')!,
      params.get('runId')!,
      signal,
    );
    const value = {
      ownerScope: await autoSellRunEnrollmentOwnerScope(user.userId),
      evidence,
      ...authority,
    };
    if (signal.aborted) throw Error('Waiting stopped');
    const text = JSON.stringify(value);
    if (
      new TextEncoder().encode(text).byteLength >
      AUTO_SELL_RUN_PROGRESS_MAX_BYTES
    )
      return json({ error: autoSellRunProgressCapacityMessage }, 409);
    return new Response(text, {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return signal.aborted
      ? json(
          {
            error:
              'Waiting stopped. Inspect the original saved run again; no allowance was released.',
          },
          408,
        )
      : error instanceof AutoSellRunProgressStorageError
        ? json({ error: error.message }, error.status)
        : json(
            {
              error:
                'Complete saved progress is unavailable. Keep the original run and attempt IDs.',
            },
            503,
          );
  }
}
