import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { autoSellRunId } from '@/lib/auto-sell-run';
import { AutoSellRunStorageError } from '@/lib/auto-sell-run-storage';
import { readOwnedAutoSellRunPacket } from '@/lib/auto-sell-run-packet-storage';

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
    {
      status,
      headers: { 'cache-control': 'no-store' },
    },
  );

/** Saved-only inspection of one original owned attempt. Never prepares,
 * refreshes, signs, submits, settles or releases allowance. */
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json(
      { error: 'Sign in to inspect the original Auto Sell preparation.' },
      401,
    );
  const params = new URL(request.url).searchParams;
  let runId: string, attemptId: string;
  try {
    if (
      [...params.keys()].length !== 2 ||
      params.getAll('runId').length !== 1 ||
      params.getAll('attemptId').length !== 1
    )
      throw new Error();
    runId = autoSellRunId(params.get('runId'));
    attemptId = autoSellRunId(params.get('attemptId'));
  } catch {
    return json(
      { error: 'Choose the exact original run and attempt IDs.' },
      400,
    );
  }
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]);
  try {
    return json(
      await readOwnedAutoSellRunPacket(
        getD1(),
        user.userId,
        runId,
        attemptId,
        signal,
      ),
    );
  } catch (error) {
    if (signal.aborted)
      return json(
        {
          error:
            'Recovery waiting stopped. Keep the original IDs; no allowance was released.',
        },
        408,
      );
    if (error instanceof AutoSellRunStorageError)
      return json(
        { error: error.message },
        error.status === 499 ? 408 : error.status,
      );
    return json(
      {
        error:
          'The original unsigned preparation could not be verified. Keep its original IDs; do not start another attempt.',
      },
      503,
    );
  }
}
