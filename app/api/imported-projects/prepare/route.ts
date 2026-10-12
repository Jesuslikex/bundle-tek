import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { prepareOwnedImportedSwap } from '@/lib/prepare-owned-imported-swap';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return Response.json(
      { error: 'Sign in to prepare a swap.' },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    );
  return prepareOwnedImportedSwap(request, user.userId, getD1());
}
