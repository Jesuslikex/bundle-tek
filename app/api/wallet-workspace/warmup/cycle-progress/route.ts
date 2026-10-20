import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  loadWalletWarmupProgress,
  WalletWarmupProgressError,
} from '@/lib/wallet-warmup-progress-server';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view cycle progress.' }, 401);
  const params = new URL(request.url).searchParams,
    id = params.get('id'),
    revision = params.get('revision'),
    earlier = params.get('includeEarlier');
  if (
    !id ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(id) ||
    !revision ||
    !/^[1-9]\d{0,8}$/.test(revision) ||
    (earlier !== null && earlier !== 'true' && earlier !== 'false')
  )
    return json(
      { error: 'Choose a saved plan revision and progress scope.' },
      400,
    );
  try {
    const { progress, performance } = await loadWalletWarmupProgress(
      getD1(),
      user.userId,
      id,
      Number(revision),
      earlier === 'true',
    );
    return json({ ...progress, performance });
  } catch (error) {
    if (error instanceof WalletWarmupProgressError)
      return json({ error: error.message }, error.status);
    return json(
      {
        error:
          'Recorded cycle progress unavailable. No completion is inferred.',
      },
      503,
    );
  }
}
