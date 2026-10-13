import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { validateTokenSource } from '@/lib/token-source';
import {
  CANDLE_NETWORKS,
  candleCurrency,
  observePoolCandles,
  type PoolCandles,
  candleSelection,
  appendOlderCandles,
  refreshSavedCandles,
  MAX_SAVED_CANDLES,
} from '@/lib/pool-candles';
import type { SavedTokenMarket } from '@/lib/token-market';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
function input(value: {
  id?: unknown;
  revision?: unknown;
  pool?: unknown;
  interval?: unknown;
  mode?: unknown;
  currency?: unknown;
}) {
  if (
    !value ||
    typeof value.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value.id,
    ) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    Number(value.revision) >= 1000000000 ||
    (value.mode !== undefined &&
      value.mode !== 'latest' &&
      value.mode !== 'follow' &&
      value.mode !== 'older')
  )
    throw new Error();
  return {
    id: value.id,
    revision: Number(value.revision),
    pool: value.pool,
    interval: value.interval,
    mode: value.mode ?? 'latest',
    currency: candleCurrency(value.currency ?? 'usd'),
  };
}
type Context = {
  chain: string;
  address: string;
  revision: number;
  archived: number;
  document: string | null;
  market_document: string | null;
};
function context(db: D1Database, owner: string, id: string) {
  return db
    .prepare(
      'SELECT p.chain,p.address,p.revision,p.archived,m.document,prices.document AS market_document FROM imported_token_projects p LEFT JOIN imported_pool_candles m ON m.owner_id=p.owner_id AND m.project_id=p.id LEFT JOIN imported_market_observations prices ON prices.owner_id=p.owner_id AND prices.project_id=p.id WHERE p.owner_id=? AND p.id=?',
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
      currency: params.get('currency') ?? 'usd',
    });
  } catch {
    return json({ error: 'Choose an imported project revision.' }, 400);
  }
  try {
    const row = await context(getD1(), user.userId, query.id);
    if (!row) return json({ error: 'Imported project not found.' }, 404);
    if (row.revision !== query.revision)
      return json({ error: 'Project changed. Reload imported projects.' }, 409);
    if (query.currency === 'sol' && row.chain !== 'Solana')
      return json(
        { error: 'SOL-denominated candles require a Solana token project.' },
        400,
      );
    return json({
      id: query.id,
      revision: row.revision,
      observations: row.document
        ? (JSON.parse(row.document) as PoolCandles[]).filter(
            (p) => (p.currency ?? 'usd') === query.currency,
          )
        : [],
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
  let selection: ReturnType<typeof candleSelection>;
  let priorSelection: PoolCandles | undefined;
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
    try {
      selection = candleSelection(row.chain, query.pool, query.interval);
      candleCurrency(query.currency, row.chain);
      const markets: SavedTokenMarket[] = row.market_document
        ? JSON.parse(row.market_document)
        : [];
      if (!markets[0]?.pairs.some((p) => p.address === selection.pool))
        throw new Error();
      const saved: PoolCandles[] = row.document ? JSON.parse(row.document) : [];
      priorSelection = saved.find(
        (p) =>
          p.pool === selection.pool &&
          p.interval === selection.interval &&
          (p.currency ?? 'usd') === query.currency,
      );
      if (
        query.mode === 'older' &&
        (!priorSelection?.candles.length ||
          priorSelection.olderExhausted ||
          priorSelection.candles.length >= MAX_SAVED_CANDLES)
      )
        return json(
          {
            error:
              'Refresh latest candles first, or the saved history limit has been reached.',
          },
          400,
        );
    } catch {
      return json(
        {
          error:
            'Choose a pool from the latest saved market observation and a supported candle interval.',
        },
        400,
      );
    }
    if (!CANDLE_NETWORKS[row.chain])
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
    const args = [
      validateTokenSource({ chain: row.chain, address: row.address }),
      selection.pool,
      selection.interval,
      AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
    ] as const;
    observation =
      query.mode === 'older'
        ? appendOlderCandles(
            priorSelection!,
            await observePoolCandles(
              ...args,
              fetch,
              priorSelection!.candles[0].time,
              query.currency,
            ),
          )
        : await observePoolCandles(...args, fetch, undefined, query.currency);
    if (
      (observation.currency ?? 'usd') !== query.currency ||
      observation.chain !== row.chain ||
      observation.address !== row.address ||
      observation.pool !== selection.pool ||
      observation.interval !== selection.interval ||
      (query.currency === 'sol' &&
        observation.quoteMint !== 'So11111111111111111111111111111111111111112')
    )
      throw new Error('Candle denomination differs.');
    if (query.mode === 'follow' && priorSelection)
      observation = refreshSavedCandles(priorSelection, observation);
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
    const previous: PoolCandles[] = row.document
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
      ...previous.filter(
        (p) =>
          p.pool !== selection.pool ||
          p.interval !== selection.interval ||
          (p.currency ?? 'usd') !== query.currency,
      ),
    ].slice(0, 20);
    const result = await db
      .prepare(`INSERT INTO imported_pool_candles(owner_id,project_id,document,observed_at)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND archived=0)
      AND EXISTS(SELECT 1 FROM imported_market_observations WHERE owner_id=? AND project_id=? AND document=?)
      AND (?='' AND NOT EXISTS(SELECT 1 FROM imported_pool_candles WHERE owner_id=? AND project_id=?) OR EXISTS(SELECT 1 FROM imported_pool_candles WHERE owner_id=? AND project_id=? AND document=?))
      ON CONFLICT(owner_id,project_id) DO UPDATE SET document=excluded.document,observed_at=excluded.observed_at WHERE imported_pool_candles.observed_at<excluded.observed_at`)
      .bind(
        user.userId,
        query.id,
        JSON.stringify(observations),
        observation.observedAt,
        user.userId,
        query.id,
        query.revision,
        user.userId,
        query.id,
        row.market_document,
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
      observations: observations.filter(
        (p) => (p.currency ?? 'usd') === query.currency,
      ),
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
