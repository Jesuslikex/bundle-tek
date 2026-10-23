import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  readWarmupExecutionInventory,
  parseWarmupExecutionInventoryCursor,
  WarmupExecutionInventoryError,
} from '@/lib/wallet-warmup-execution-inventory';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json(
      { error: 'Sign in to read original warmup execution history.' },
      401,
    );
  let cursor: string | undefined;
  try {
    const params = new URL(request.url).searchParams;
    if (
      request.url.length > 2048 ||
      request.body !== null ||
      [...params.keys()].some((k) => k !== 'cursor') ||
      params.getAll('cursor').length > 1
    )
      throw new WarmupExecutionInventoryError(400);
    cursor = params.get('cursor') ?? undefined;
    parseWarmupExecutionInventoryCursor(cursor);
  } catch {
    return json({ error: 'Choose one original bounded history cursor.' }, 400);
  }
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
  try {
    return json(
      await readWarmupExecutionInventory(getD1(), user.userId, cursor, signal),
    );
  } catch (error) {
    if (signal.aborted)
      return json(
        {
          error:
            'History read ended before confirmation. No proposal, approval or execution was changed.',
        },
        408,
      );
    return json(
      {
        error:
          error instanceof WarmupExecutionInventoryError
            ? error.message
            : 'Warmup execution history is unavailable. No execution was authorized.',
      },
      error instanceof WarmupExecutionInventoryError ? error.status : 503,
    );
  }
}
