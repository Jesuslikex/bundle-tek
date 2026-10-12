import { UUID } from './wallet-operation';

export type WarmupReceiptCursor = { createdAt: string; id: string };
export function warmupReceiptCursor(
  raw: string | null,
): WarmupReceiptCursor | null {
  if (raw === null) return null;
  if (raw.length > 200) throw new Error('Invalid receipt cursor.');
  const cursor = JSON.parse(raw);
  if (
    !cursor ||
    Object.keys(cursor).length !== 2 ||
    !UUID.test(cursor.id) ||
    !Number.isFinite(Date.parse(cursor.createdAt)) ||
    new Date(cursor.createdAt).toISOString() !== cursor.createdAt ||
    JSON.stringify(cursor) !== raw
  )
    throw new Error('Invalid receipt cursor.');
  return cursor;
}

export async function warmupReceiptPage<
  T extends { id: string; createdAt: string },
>(
  db: D1Database,
  side: 'buy' | 'sell',
  columns: string,
  owner: string,
  planId: string,
  cursor: WarmupReceiptCursor | null,
) {
  const table = side === 'buy' ? 'warmup_buy_receipts' : 'warmup_sell_receipts';
  if (
    cursor &&
    !(await db
      .prepare(
        `SELECT id FROM ${table} WHERE owner_id=? AND plan_id=? AND id=? AND created_at=?`,
      )
      .bind(owner, planId, cursor.id, cursor.createdAt)
      .first())
  )
    return null;
  const rows = await db
    .prepare(
      `SELECT ${columns} FROM ${table} WHERE owner_id=? AND plan_id=? ${cursor ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT 51`,
    )
    .bind(
      owner,
      planId,
      ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []),
    )
    .all<T>();
  const selected = rows.results.slice(0, 50),
    last = selected.at(-1);
  return {
    rows: selected,
    nextCursor:
      rows.results.length > 50 && last
        ? JSON.stringify({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}
