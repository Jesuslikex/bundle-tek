export type PumpHistoryKind = 'create' | 'developer' | 'holders';
export type PumpHistoryPage = {
  before: { createdAt: string; id: string } | null;
};
export class PumpHistoryRequestError extends Error {}
const predicates: Record<PumpHistoryKind, string> = {
  create:
    "json_type(terms,'$.maximumQuoteCostRaw') IS NULL AND COALESCE(json_extract(review,'$.format'),'')!='pump-create-holders-review-v1'",
  developer:
    "json_type(terms,'$.maximumQuoteCostRaw') IS NOT NULL AND COALESCE(json_extract(review,'$.format'),'')!='pump-create-holders-review-v1'",
  holders: "json_extract(review,'$.format')='pump-create-holders-review-v1'",
};
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[\x21-\x7e]{1,128}$/.test(id);
const validDate = (date: unknown): date is string =>
  typeof date === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(date) &&
  new Date(date).toISOString() === date;
function encode(
  kind: PumpHistoryKind,
  projectId: string,
  createdAt: string,
  id: string,
) {
  return Buffer.from(
    JSON.stringify({ v: 1, kind, projectId, createdAt, id }),
    'utf8',
  ).toString('base64url');
}
/** The cursor is a position, not authorization. Every read still binds authenticated owner/project/type. */
export function pumpHistoryPageRequest(
  params: URLSearchParams,
  projectId: string,
  kind: PumpHistoryKind,
): PumpHistoryPage | null {
  const pages = params.getAll('page'),
    cursors = params.getAll('cursor');
  if (!pages.length && !cursors.length) return null;
  try {
    if (pages.length !== 1 || pages[0] !== '1' || cursors.length > 1)
      throw new Error();
    if (!cursors.length) return { before: null };
    const cursor = cursors[0];
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) throw new Error();
    const data = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      !data ||
      typeof data !== 'object' ||
      Object.keys(data).sort().join(',') !== 'createdAt,id,kind,projectId,v' ||
      data.v !== 1 ||
      data.kind !== kind ||
      data.projectId !== projectId ||
      !validId(data.id) ||
      !validDate(data.createdAt) ||
      encode(kind, projectId, data.createdAt, data.id) !== cursor
    )
      throw new Error();
    return { before: { createdAt: data.createdAt, id: data.id } };
  } catch {
    throw new PumpHistoryRequestError(
      'Invalid saved launch history cursor. Reload the first page.',
    );
  }
}
export async function readPumpHistoryPage<T, R>(
  db: D1Database,
  owner: string,
  projectId: string,
  kind: PumpHistoryKind,
  page: PumpHistoryPage,
  convert: (row: T) => R,
) {
  const before = page.before;
  const { results } = await db
    .prepare(`SELECT * FROM pump_launch_reviews WHERE owner_id=? AND project_id=? AND (${predicates[kind]})
    ${before ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''}
    ORDER BY created_at DESC,id DESC LIMIT 21`)
    .bind(
      owner,
      projectId,
      ...(before ? [before.createdAt, before.createdAt, before.id] : []),
    )
    .all<T & { id: string; created_at: string }>();
  const visible = results.slice(0, 20),
    last = visible.at(-1);
  if (last && (!validId(last.id) || !validDate(last.created_at)))
    throw new Error('Saved launch history position is unavailable.');
  return {
    launches: visible.map(convert),
    nextCursor:
      results.length > 20 && last
        ? encode(kind, projectId, last.created_at, last.id)
        : null,
  };
}
