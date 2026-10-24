import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  LaunchRecoveryDiscoveryRequestError,
  launchRecoveryPageRequest,
} from '@/lib/launch-recovery-discovery';
import { readLaunchRecoveryPage } from '@/lib/launch-recovery-discovery-server';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user)
      return json({ error: 'Sign in to find saved launch recoveries.' }, 401);
    const cursor = launchRecoveryPageRequest(new URL(request.url).searchParams);
    return json(
      await readLaunchRecoveryPage(
        getD1(),
        user.userId,
        cursor,
        request.signal,
      ),
    );
  } catch (error) {
    if (error instanceof LaunchRecoveryDiscoveryRequestError)
      return json({ error: error.message }, 400);
    return json(
      {
        error:
          'Saved launch recoveries could not be checked completely. No partial cross-venue view is shown.',
      },
      503,
    );
  }
}
