import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import type {
  ImportedTokenDocument,
  ImportedTokenEvent,
} from '@/lib/imported-token-project';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to read imported project activity.' }, 401);
  const raw = new URL(request.url).searchParams.get('cursor');
  let cursor: [string, string] | undefined;
  if (raw !== null) {
    try {
      if (raw.length > 100) throw new Error();
      const value: unknown = JSON.parse(raw);
      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        typeof value[0] !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value[0]) ||
        new Date(value[0]).toISOString() !== value[0] ||
        typeof value[1] !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          value[1],
        )
      )
        throw new Error();
      cursor = [value[0], value[1]];
    } catch {
      return json({ error: 'Invalid imported activity cursor.' }, 400);
    }
  }
  try {
    const rows = await getD1()
      .prepare(
        `SELECT id,project_id AS projectId,type,revision,document,created_at AS createdAt FROM imported_token_project_events WHERE owner_id=? ${cursor ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT 51`,
      )
      .bind(user.userId, ...(cursor ? [cursor[0], cursor[0], cursor[1]] : []))
      .all<Omit<ImportedTokenEvent, 'document'> & { document: string }>();
    const events = rows.results.slice(0, 50).map(({ document, ...event }) => {
      const { token } = JSON.parse(document) as ImportedTokenDocument;
      return {
        ...event,
        token: {
          name: token.name,
          symbol: token.symbol,
          chain: token.chain,
          address: token.address,
        },
      };
    });
    const last = events.at(-1);
    return json({
      events,
      nextCursor:
        rows.results.length > 50 && last
          ? JSON.stringify([last.createdAt, last.id])
          : null,
    });
  } catch {
    return json({ error: 'Imported activity temporarily unavailable.' }, 503);
  }
}
