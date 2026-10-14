import { getD1 } from '@/db';
import { cronAuthorized } from '@/lib/cron-auth';
import { runSessionPreparationJobs } from '@/lib/session-preparation-jobs';
import { prepareOwnedImportedSwap } from '@/lib/prepare-owned-imported-swap';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET(request: Request) {
  if (!cronAuthorized(request))
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (process.env.SESSION_PREPARATION_ENABLED !== 'true')
    return Response.json({ enabled: false });
  await runSessionPreparationJobs(getD1(), prepareOwnedImportedSwap);
  return Response.json({ completed: true });
}
