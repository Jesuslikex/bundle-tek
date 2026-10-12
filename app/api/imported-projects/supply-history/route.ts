import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { observeSupplyPartition } from '@/lib/supply-partition';
import {
  canonicalSupplyScope,
  supplyScopeId,
  captureSupply,
  requireSupplyHistoryRow,
  type SupplyHistoryRow,
  type SupplyCapture,
} from '@/lib/supply-history';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
function identity(id: unknown, revision: unknown) {
  if (
    typeof id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(id) ||
    !Number.isSafeInteger(revision) ||
    Number(revision) < 1
  )
    throw new Error('Invalid project.');
  return { id, revision: Number(revision) };
}
type Project = {
  revision: number;
  archived: number;
  chain: string;
  address: string;
};
const project = (db: D1Database, owner: string, id: string) =>
  db
    .prepare(
      'SELECT revision,archived,chain,address FROM imported_token_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, id)
    .first<Project>();
type SavedRow = {
  sequence: number;
  id: string;
  scope_id: string;
  document: string;
};
const decode = (r: SavedRow): SupplyHistoryRow => ({
  sequence: r.sequence,
  id: r.id,
  scopeId: r.scope_id,
  document: JSON.parse(r.document) as SupplyCapture,
});
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to read supply history.' }, 401);
  let query, scopeId: string | null, cursor: number | null;
  try {
    const p = new URL(request.url).searchParams;
    if (
      [...p.keys()].some(
        (k) =>
          !['id', 'revision', 'scope', 'cursor'].includes(k) ||
          p.getAll(k).length !== 1,
      )
    )
      throw new Error();
    query = identity(p.get('id'), Number(p.get('revision')));
    scopeId = p.get('scope');
    cursor = p.has('cursor') ? Number(p.get('cursor')) : null;
    if (
      (scopeId !== null && !/^[a-f0-9]{64}$/.test(scopeId)) ||
      (cursor !== null &&
        (!scopeId || !Number.isSafeInteger(cursor) || cursor < 1))
    )
      throw new Error();
  } catch {
    return json({ error: 'Choose a saved supply history scope.' }, 400);
  }
  try {
    const db = getD1(),
      row = await project(db, user.userId, query.id);
    if (!row) return json({ error: 'Imported project not found.' }, 404);
    if (row.revision !== query.revision)
      return json({ error: 'Project changed. Reload projects.' }, 409);
    const scopes = (
      await db
        .prepare(
          'SELECT s.id,s.document,MAX(o.sequence) AS latest FROM imported_supply_scopes s LEFT JOIN imported_supply_observations o ON o.owner_id=s.owner_id AND o.project_id=s.project_id AND o.scope_id=s.id WHERE s.owner_id=? AND s.project_id=? GROUP BY s.id ORDER BY latest DESC LIMIT 100',
        )
        .bind(user.userId, query.id)
        .all<{ id: string; document: string; latest: number | null }>()
    ).results.map((s) => ({
      id: s.id,
      scope: canonicalSupplyScope(JSON.parse(s.document)),
    }));
    const selected = scopeId ? scopes.find((s) => s.id === scopeId) : scopes[0];
    if (scopeId && !selected)
      return json({ error: 'Supply scope not found.' }, 404);
    if (!selected)
      return json({
        id: query.id,
        revision: row.revision,
        scopes: [],
        scopeId: null,
        items: [],
        nextCursor: null,
      });
    if (
      cursor &&
      !(await db
        .prepare(
          'SELECT sequence FROM imported_supply_observations WHERE owner_id=? AND project_id=? AND scope_id=? AND sequence=?',
        )
        .bind(user.userId, query.id, selected.id, cursor)
        .first())
    )
      return json({ error: 'History cursor differs from this scope.' }, 400);
    const items = (
      await db
        .prepare(
          'SELECT sequence,id,scope_id,document FROM imported_supply_observations WHERE owner_id=? AND project_id=? AND scope_id=? AND sequence<? ORDER BY sequence DESC LIMIT 51',
        )
        .bind(
          user.userId,
          query.id,
          selected.id,
          cursor ?? Number.MAX_SAFE_INTEGER,
        )
        .all<SavedRow>()
    ).results.map(decode);
    for (const item of items)
      requireSupplyHistoryRow(item, selected.scope, selected.id);
    return json({
      id: query.id,
      revision: row.revision,
      scopes,
      scopeId: selected.id,
      items: items.slice(0, 50),
      nextCursor: items.length > 50 ? items[49].sequence : null,
    });
  } catch {
    return json({ error: 'Supply history storage unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to save supply reads.' }, 401);
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
  let query, wallets;
  try {
    const text = await request.text();
    if (text.length > 4096)
      return json({ error: 'Supply request too large.' }, 413);
    const body = JSON.parse(text);
    if (
      Object.keys(body).some((k) => !['id', 'revision', 'wallets'].includes(k))
    )
      throw new Error();
    query = identity(body.id, body.revision);
    wallets = body.wallets;
  } catch {
    return json({ error: 'Choose a project and classified wallets.' }, 400);
  }
  try {
    const db = getD1(),
      row = await project(db, user.userId, query.id);
    if (!row) return json({ error: 'Imported project not found.' }, 404);
    if (
      row.revision !== query.revision ||
      row.archived ||
      row.chain !== 'Solana'
    )
      return json({ error: 'Choose an active Solana project revision.' }, 409);
    let scope;
    try {
      scope = canonicalSupplyScope({ mint: row.address, wallets });
    } catch {
      return json({ error: 'Choose 1 to 12 unique classified wallets.' }, 400);
    }
    const savedWallets = await Promise.all(
      scope.wallets.map((w) =>
        db
          .prepare(
            "SELECT revision FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND archived=0",
          )
          .bind(user.userId, w.address)
          .first<{ revision: number }>(),
      ),
    );
    if (savedWallets.some((w) => !w))
      return json({ error: 'Select active saved Solana wallets.' }, 409);
    const scopeId = await supplyScopeId(scope),
      scopeText = JSON.stringify(scope);
    const known = await db
      .prepare(
        'SELECT id FROM imported_supply_scopes WHERE owner_id=? AND project_id=? AND id=?',
      )
      .bind(user.userId, query.id, scopeId)
      .first();
    if (!known) {
      const count = await db
        .prepare(
          'SELECT COUNT(*) AS count FROM imported_supply_scopes WHERE owner_id=? AND project_id=?',
        )
        .bind(user.userId, query.id)
        .first<{ count: number }>();
      if ((count?.count ?? 0) >= 100)
        return json(
          { error: 'This project has reached 100 retained supply scopes.' },
          409,
        );
    }
    const now = Date.now(),
      gate = await db
        .prepare(
          'INSERT INTO imported_supply_read_gates(owner_id,next_allowed_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_supply_read_gates.next_allowed_at<=?',
        )
        .bind(user.userId, now + 15000, now)
        .run();
    if (!gate.meta.changes)
      return json(
        { error: 'Wait 15 seconds between saved supply reads.' },
        429,
      );
    const previousRaw = await db
      .prepare(
        'SELECT sequence,id,scope_id,document FROM imported_supply_observations WHERE owner_id=? AND project_id=? AND scope_id=? ORDER BY sequence DESC LIMIT 1',
      )
      .bind(user.userId, query.id, scopeId)
      .first<SavedRow>();
    const previous = previousRaw
      ? requireSupplyHistoryRow(decode(previousRaw), scope, scopeId)
      : null;
    let snapshot;
    try {
      snapshot = await observeSupplyPartition(
        scope,
        AbortSignal.any([request.signal, AbortSignal.timeout(25000)]),
      );
    } catch {
      return json(
        { error: 'Supply provider read unavailable or inconsistent.' },
        502,
      );
    }
    let capture;
    try {
      capture = captureSupply(snapshot, scope, row.revision, previous);
    } catch {
      return json(
        {
          error:
            'Supply sample differs or overlaps the previous observation. Retry later.',
        },
        409,
      );
    }
    const stamp = new Date().toISOString(),
      id = crypto.randomUUID();
    const walletGuard = scope.wallets
      .map(
        () =>
          "EXISTS(SELECT 1 FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND address=? AND revision=? AND archived=0)",
      )
      .join(' AND ');
    const guards = scope.wallets.flatMap((w, i) => [
      user.userId,
      w.address,
      savedWallets[i]!.revision,
    ]);
    const result = await db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO imported_supply_scopes(owner_id,project_id,id,document,created_at) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM imported_supply_scopes WHERE owner_id=? AND project_id=?)<100 AND EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND archived=0 AND chain='Solana' AND address=?) AND ${walletGuard} AND COALESCE((SELECT MAX(sequence) FROM imported_supply_observations WHERE owner_id=? AND project_id=? AND scope_id=?),0)=?`,
        )
        .bind(
          user.userId,
          query.id,
          scopeId,
          scopeText,
          stamp,
          user.userId,
          query.id,
          user.userId,
          query.id,
          row.revision,
          row.address,
          ...guards,
          user.userId,
          query.id,
          scopeId,
          previous?.sequence ?? 0,
        ),
      db
        .prepare(
          `INSERT INTO imported_supply_observations(id,owner_id,project_id,scope_id,document,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND archived=0 AND chain='Solana' AND address=?) AND ${walletGuard} AND COALESCE((SELECT MAX(sequence) FROM imported_supply_observations WHERE owner_id=? AND project_id=? AND scope_id=?),0)=? AND EXISTS(SELECT 1 FROM imported_supply_scopes WHERE owner_id=? AND project_id=? AND id=? AND document=?)`,
        )
        .bind(
          id,
          user.userId,
          query.id,
          scopeId,
          JSON.stringify(capture),
          stamp,
          user.userId,
          query.id,
          row.revision,
          row.address,
          ...guards,
          user.userId,
          query.id,
          scopeId,
          previous?.sequence ?? 0,
          user.userId,
          query.id,
          scopeId,
          scopeText,
        ),
    ]);
    if (!result[1].meta.changes)
      return json(
        {
          error:
            'Project, wallet, or supply history changed during this read. Reload.',
        },
        409,
      );
    const saved = await db
      .prepare(
        'SELECT sequence,id,scope_id,document FROM imported_supply_observations WHERE owner_id=? AND project_id=? AND id=?',
      )
      .bind(user.userId, query.id, id)
      .first<SavedRow>();
    return json({
      id: query.id,
      revision: row.revision,
      scopeId,
      scope,
      item: decode(saved!),
    });
  } catch {
    return json({ error: 'Supply history storage unavailable.' }, 503);
  }
}
