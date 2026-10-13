import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { UUID } from '@/lib/wallet-operation';
import {
  jitoBaselinePending,
  recordJitoBaselines,
} from '@/lib/jito-bundle-baseline';
import {
  isJitoBundleEvent,
  type JitoBundleEvent,
} from '@/lib/jito-bundle-events';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to view Jito bundle activity.' }, 401);
  const params = new URL(request.url).searchParams;
  const cursor = params.get('cursor'),
    bundleId = params.get('bundleId');
  if (
    (cursor !== null && !/^[a-f0-9]{32}$/.test(cursor)) ||
    (bundleId !== null && !UUID.test(bundleId))
  )
    return json({ error: 'Invalid bundle activity context.' }, 400);
  try {
    const db = getD1();
    if (
      bundleId &&
      !(await db
        .prepare('SELECT id FROM jito_bundles WHERE owner_id=? AND id=?')
        .bind(user.userId, bundleId)
        .first())
    )
      return json({ error: 'Owned bundle unavailable.' }, 404);
    const anchor = cursor
      ? await db
          .prepare(
            'SELECT sequence,created_at AS createdAt FROM jito_bundle_events WHERE owner_id=? AND id=? AND (? IS NULL OR bundle_id=?)',
          )
          .bind(user.userId, cursor, bundleId, bundleId)
          .first<{ sequence: number; createdAt: string }>()
      : null;
    if (cursor && !anchor)
      return json({ error: 'Bundle activity cursor unavailable.' }, 400);
    const { results } = await db
      .prepare(
        'SELECT id,sequence,bundle_id AS bundleId,project_id AS projectId,session_id AS sessionId,type,packet,document,created_at AS createdAt FROM jito_bundle_events WHERE owner_id=? AND (? IS NULL OR bundle_id=?) AND (? IS NULL OR created_at<? OR (created_at=? AND sequence<?)) ORDER BY created_at DESC,sequence DESC LIMIT 51',
      )
      .bind(
        user.userId,
        bundleId,
        bundleId,
        anchor?.createdAt ?? null,
        anchor?.createdAt ?? '',
        anchor?.createdAt ?? '',
        anchor?.sequence ?? 0,
      )
      .all<Omit<JitoBundleEvent, 'document'> & { document: string }>();
    const events = results.slice(0, 50).map((row) => {
      const event = { ...row, document: JSON.parse(row.document) };
      if (!isJitoBundleEvent(event)) throw new Error();
      return event;
    });
    return json({
      events,
      nextCursor: results.length > 50 ? events.at(-1)!.id : null,
      baselinePending: await jitoBaselinePending(db, user.userId),
    });
  } catch {
    return json({ error: 'Jito bundle activity unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to record bundle baselines.' }, 401);
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
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 512)
    return json({ error: 'Baseline request too large.' }, 413);
  let body: { action?: unknown; approved?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Invalid baseline request.' }, 400);
  }
  if (!body || body.action !== 'record-baselines' || body.approved !== true)
    return json({ error: 'Explicit baseline recording required.' }, 400);
  try {
    return json(await recordJitoBaselines(getD1(), user.userId));
  } catch {
    return json(
      { error: 'Bundle baselines unavailable. Refresh before retrying.' },
      503,
    );
  }
}
