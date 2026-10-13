import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { UUID } from '@/lib/wallet-operation';
import {
  configureConditionalMonitor,
  readConditionalMonitor,
  MonitorConflict,
} from '@/lib/conditional-monitor-server';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to read conditional monitoring.' }, 401);
  const query = new URL(request.url).searchParams,
    projectId = query.get('projectId');
  if (
    [...query.keys()].join(',') !== 'projectId' ||
    !projectId ||
    !UUID.test(projectId)
  )
    return json({ error: 'Choose an imported project.' }, 400);
  try {
    const page = await readConditionalMonitor(getD1(), user.userId, projectId);
    return page
      ? json(page)
      : json({ error: 'Imported project unavailable.' }, 404);
  } catch {
    return json(
      {
        error: 'Conditional monitoring storage is unavailable or not upgraded.',
      },
      503,
    );
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to manage conditional monitoring.' }, 401);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin request rejected.' }, 403);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  let input: {
    projectId: string;
    projectRevision: number;
    monitorRevision: number;
    enabled: boolean;
  };
  try {
    const body = await walletRequest(request, 1024);
    if (
      Object.keys(body).sort().join(',') !==
        'enabled,monitorRevision,projectId,projectRevision' ||
      typeof body.projectId !== 'string' ||
      !UUID.test(body.projectId) ||
      !Number.isSafeInteger(body.projectRevision) ||
      Number(body.projectRevision) < 1 ||
      Number(body.projectRevision) >= 1e9 ||
      !Number.isSafeInteger(body.monitorRevision) ||
      Number(body.monitorRevision) < 0 ||
      Number(body.monitorRevision) >= 1e9 ||
      typeof body.enabled !== 'boolean'
    )
      throw new Error();
    input = body as typeof input;
  } catch {
    return json({ error: 'Review valid monitoring settings.' }, 400);
  }
  try {
    const page = await configureConditionalMonitor(getD1(), user.userId, input);
    return page
      ? json(page)
      : json({ error: 'Imported project unavailable.' }, 404);
  } catch (e) {
    return e instanceof MonitorConflict
      ? json({ error: e.message }, 409)
      : json(
          {
            error:
              'Conditional monitoring storage is unavailable or not upgraded.',
          },
          503,
        );
  }
}
