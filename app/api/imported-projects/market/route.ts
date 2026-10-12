import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { validateTokenSource } from '@/lib/token-source';
import {
  MARKET_CHAINS,
  observeTokenMarket,
  type SavedTokenMarket,
} from '@/lib/token-market';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
function input(value: { id?: unknown; revision?: unknown }) {
  if (
    !value ||
    typeof value.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value.id,
    ) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    Number(value.revision) >= 1000000000
  )
    throw new Error();
  return { id: value.id, revision: Number(value.revision) };
}
type Context = {
  chain: string;
  address: string;
  revision: number;
  archived: number;
  document: string | null;
};
function context(db: D1Database, owner: string, id: string) {
  return db
    .prepare(
      'SELECT p.chain,p.address,p.revision,p.archived,m.document FROM imported_token_projects p LEFT JOIN imported_market_observations m ON m.owner_id=p.owner_id AND m.project_id=p.id WHERE p.owner_id=? AND p.id=?',
    )
    .bind(owner, id)
    .first<Context>();
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to read market observations.' }, 401);
  let query;
  try {
    const params = new URL(request.url).searchParams;
    query = input({
      id: params.get('id'),
      revision: Number(params.get('revision')),
    });
  } catch {
    return json({ error: 'Choose an imported project revision.' }, 400);
  }
  try {
    const row = await context(getD1(), user.userId, query.id);
    if (!row) return json({ error: 'Imported project not found.' }, 404);
    if (row.revision !== query.revision)
      return json({ error: 'Project changed. Reload imported projects.' }, 409);
    return json({
      id: query.id,
      revision: row.revision,
      observations: row.document ? JSON.parse(row.document) : [],
      executionAllowed: false,
    });
  } catch {
    return json(
      { error: 'Market observation storage temporarily unavailable.' },
      503,
    );
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to refresh market observations.' }, 401);
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
  let query;
  try {
    const text = await request.text();
    if (text.length > 200) return json({ error: 'Request too large.' }, 413);
    query = input(JSON.parse(text));
  } catch {
    return json({ error: 'Choose an imported project revision.' }, 400);
  }
  let db: D1Database;
  let row: Context;
  try {
    db = getD1();
    const owned = await context(db, user.userId, query.id);
    if (!owned) return json({ error: 'Imported project not found.' }, 404);
    if (owned.revision !== query.revision || owned.archived)
      return json(
        { error: 'Project changed or is archived. Reload imported projects.' },
        409,
      );
    row = owned;
    if (!MARKET_CHAINS[row.chain])
      return json(
        {
          error:
            'Market observations currently support Solana, Ethereum, Base and BNB.',
        },
        400,
      );
    const now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO market_read_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE market_read_gates.next_allowed_at<=?',
      )
      .bind(user.userId, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      return json(
        { error: 'Wait 15 seconds between market provider reads.' },
        429,
      );
  } catch {
    return json(
      { error: 'Market observation storage temporarily unavailable.' },
      503,
    );
  }
  let observation;
  try {
    observation = await observeTokenMarket(
      validateTokenSource({ chain: row.chain, address: row.address }),
      AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
    );
  } catch {
    return json(
      {
        error:
          'Market provider unavailable or returned inconsistent pairs. Saved observations retained.',
      },
      502,
    );
  }
  try {
    const previous: SavedTokenMarket[] = row.document
      ? JSON.parse(row.document)
      : [];
    if (previous[0] && previous[0].observedAt >= observation.observedAt)
      return json(
        {
          error:
            'Market observation time regressed. Saved observations retained.',
        },
        409,
      );
    const observations = [
      { ...observation, projectRevision: query.revision },
      ...previous,
    ].slice(0, 20);
    const result = await db
      .prepare(`INSERT INTO imported_market_observations(owner_id,project_id,document,observed_at)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND archived=0)
      AND (?='' AND NOT EXISTS(SELECT 1 FROM imported_market_observations WHERE owner_id=? AND project_id=?) OR EXISTS(SELECT 1 FROM imported_market_observations WHERE owner_id=? AND project_id=? AND document=?))
      ON CONFLICT(owner_id,project_id) DO UPDATE SET document=excluded.document,observed_at=excluded.observed_at WHERE imported_market_observations.observed_at<excluded.observed_at`)
      .bind(
        user.userId,
        query.id,
        JSON.stringify(observations),
        observation.observedAt,
        user.userId,
        query.id,
        query.revision,
        row.document ?? '',
        user.userId,
        query.id,
        user.userId,
        query.id,
        row.document ?? '',
      )
      .run();
    if (!result.meta.changes)
      return json(
        {
          error:
            'Project or market observations changed during the read. Reload before retrying.',
        },
        409,
      );
    return json({
      id: query.id,
      revision: query.revision,
      observations,
      executionAllowed: false,
    });
  } catch {
    return json(
      {
        error:
          'Market observation could not be saved. Previous records retained.',
      },
      503,
    );
  }
}
