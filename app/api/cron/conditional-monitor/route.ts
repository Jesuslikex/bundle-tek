import { getD1 } from '@/db';
import { cronAuthorized } from '@/lib/cron-auth';
import { runConditionalMonitors } from '@/lib/conditional-monitor-server';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET(request: Request) {
  if (!cronAuthorized(request))
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (process.env.CONDITIONAL_MONITOR_ENABLED !== 'true')
    return Response.json({ enabled: false });
  await runConditionalMonitors(getD1());
  return Response.json({ completed: true });
}
