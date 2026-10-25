import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  LaunchRecoveryDiscoveryRequestError,
  launchRecoveryPageRequest,
} from '@/lib/launch-recovery-discovery';
import { readLaunchRecoveryPage } from '@/lib/launch-recovery-discovery-server';
import {
  launchInspectionRequest,
  LaunchInspectionRequestError,
  LaunchInspectionReadError,
} from '@/lib/launch-recovery-inspection';
import {
  readLaunchRecoveryInspection,
  LaunchInspectionStoredError,
} from '@/lib/launch-recovery-inspection-server';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  let inspection = false;
  try {
    const user = await getChatGPTUser();
    if (!user)
      return json({ error: 'Sign in to find saved launch recoveries.' }, 401);
    const reference = launchInspectionRequest(
      new URL(request.url).searchParams,
    );
    if (reference) {
      inspection = true;
      return json(
        await readLaunchRecoveryInspection(
          getD1(),
          user.userId,
          reference,
          request.signal,
        ),
      );
    }
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
    if (error instanceof LaunchInspectionRequestError)
      return json({ error: error.message }, 400);
    if (error instanceof LaunchInspectionStoredError) {
      const status = [404, 409].includes(error.status) ? error.status : 503;
      return json(
        { error: new LaunchInspectionReadError(status).message },
        status,
      );
    }
    if (error instanceof LaunchRecoveryDiscoveryRequestError)
      return json({ error: error.message }, 400);
    if (inspection)
      return json({ error: new LaunchInspectionReadError(503).message }, 503);
    return json(
      {
        error:
          'Saved launch recoveries could not be checked completely. No partial cross-venue view is shown.',
      },
      503,
    );
  }
}
