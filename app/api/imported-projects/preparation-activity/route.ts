import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { UUID } from '@/lib/wallet-operation';
import type { SavedSwapPreparation } from '@/lib/imported-swap-preparation-history';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to view preparation activity.' }, 401);
  const raw = new URL(request.url).searchParams.get('cursor');
  let cursor: { createdAt: string; id: string } | null = null;
  try {
    if (raw !== null) {
      if (raw.length > 200) throw new Error();
      cursor = JSON.parse(raw);
      if (
        !cursor ||
        Object.keys(cursor).length !== 2 ||
        !UUID.test(cursor.id) ||
        !Number.isFinite(Date.parse(cursor.createdAt)) ||
        new Date(cursor.createdAt).toISOString() !== cursor.createdAt ||
        JSON.stringify(cursor) !== raw
      )
        throw new Error();
    }
  } catch {
    return json({ error: 'Invalid preparation activity cursor.' }, 400);
  }
  try {
    const db = getD1();
    if (
      cursor &&
      !(await db
        .prepare(
          'SELECT id FROM imported_swap_preparations WHERE owner_id=? AND id=? AND created_at=?',
        )
        .bind(user.userId, cursor.id, cursor.createdAt)
        .first())
    )
      return json({ error: 'Preparation cursor unavailable.' }, 400);
    type Row = Omit<SavedSwapPreparation, 'document'> & { document: string };
    const rows = await db
      .prepare(`SELECT id,project_id AS projectId,project_revision AS projectRevision,wallet_revision AS walletRevision,created_at AS createdAt,document
      FROM imported_swap_preparations WHERE owner_id=? ${cursor ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''}
      ORDER BY created_at DESC,id DESC LIMIT 21`)
      .bind(
        user.userId,
        ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []),
      )
      .all<Row>();
    const selected = rows.results.slice(0, 20),
      last = selected.at(-1);
    return json({
      executionAllowed: false,
      preparations: selected.map((row) => ({
        ...row,
        document: JSON.parse(row.document),
      })),
      nextCursor:
        rows.results.length > 20 && last
          ? JSON.stringify({ createdAt: last.createdAt, id: last.id })
          : null,
    });
  } catch {
    return json({ error: 'Preparation activity storage unavailable.' }, 503);
  }
}
