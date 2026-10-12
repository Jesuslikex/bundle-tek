import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  canonicalSupplyScope,
  requireSupplyHistoryRow,
} from '@/lib/supply-history';
import {
  observeSupplyMovementEvidence,
  supplyMovementInterval,
  type SupplyMovementEvidence,
} from '@/lib/supply-movement-evidence';
import { signatureCursor } from '@/lib/tracked-signatures';
import { walletAddress } from '@/lib/wallet-workspace';
import { observeSupplyTokenAccounts } from '@/lib/supply-token-accounts';
export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
function input(value: unknown) {
  const b = value as Record<string, unknown>;
  if (
    !b ||
    Object.keys(b).some(
      (k) =>
        ![
          'id',
          'revision',
          'observationId',
          'wallet',
          'cursor',
          'indexedAddress',
          'mode',
          'reuseSaved',
        ].includes(k),
    ) ||
    typeof b.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(b.id) ||
    typeof b.observationId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(b.observationId) ||
    !Number.isSafeInteger(b.revision) ||
    Number(b.revision) < 1
  )
    throw new Error();
  const cursor = b.cursor ?? null;
  if (b.reuseSaved !== undefined && typeof b.reuseSaved !== 'boolean')
    throw new Error();
  if (cursor !== null && typeof cursor !== 'string') throw new Error();
  signatureCursor(cursor as string | null);
  if (b.mode !== undefined && b.mode !== 'inspect' && b.mode !== 'accounts')
    throw new Error();
  if (
    b.mode === 'accounts' &&
    (cursor !== null || b.indexedAddress !== undefined)
  )
    throw new Error();
  return {
    id: b.id,
    revision: Number(b.revision),
    observationId: b.observationId,
    wallet: walletAddress(b.wallet, 'Solana'),
    cursor: cursor as string | null,
    mode: b.mode ?? 'inspect',
    reuseSaved: b.reuseSaved === true,
    indexedAddress: walletAddress(b.indexedAddress ?? b.wallet, 'Solana'),
  };
}
type Row = { sequence: number; id: string; scope_id: string; document: string };
function checkedEvidence(
  value: SupplyMovementEvidence,
  c: NonNullable<Awaited<ReturnType<typeof context>>>,
  wallet: string,
) {
  const interval = supplyMovementInterval(c.current, c.previous, wallet);
  walletAddress(value?.indexedAddress ?? wallet, 'Solana');
  if (
    value?.indexedAddress &&
    value.indexedAddress !== wallet &&
    (!Number.isSafeInteger(value.accountObservedSlot) ||
      value.accountObservedSlot! < interval.toSlot)
  )
    throw new Error('Token account evidence context differs.');
  if (
    !value ||
    value.observationId !== c.current.id ||
    value.wallet !== wallet ||
    value.mint !== interval.mint ||
    value.fromSlot !== interval.fromSlot ||
    value.toSlot !== interval.toSlot ||
    !Number.isSafeInteger(value.anchor) ||
    value.anchor < interval.toSlot ||
    !Array.isArray(value.transactions) ||
    value.transactions.length > 5
  )
    throw new Error('Saved evidence context differs.');
  for (const t of value.transactions) {
    requireMovementClassification(t.classification, t.changeRaw);
    if (
      !Number.isSafeInteger(t.slot) ||
      t.slot <= interval.fromSlot ||
      t.slot > interval.toSlot ||
      t.decimals !== interval.decimals ||
      BigInt(t.afterRaw) - BigInt(t.beforeRaw) !== BigInt(t.changeRaw)
    )
      throw new Error('Saved transaction context differs.');
  }
  return value;
}
async function context(
  db: D1Database,
  owner: string,
  q: ReturnType<typeof input>,
) {
  const project = await db
    .prepare(
      'SELECT revision FROM imported_token_projects WHERE owner_id=? AND id=?',
    )
    .bind(owner, q.id)
    .first<{ revision: number }>();
  if (project?.revision !== q.revision) return null;
  const row = await db
    .prepare(
      'SELECT sequence,id,scope_id,document FROM imported_supply_observations WHERE owner_id=? AND project_id=? AND id=?',
    )
    .bind(owner, q.id, q.observationId)
    .first<Row>();
  if (!row) return null;
  const scope = await db
    .prepare(
      'SELECT document FROM imported_supply_scopes WHERE owner_id=? AND project_id=? AND id=?',
    )
    .bind(owner, q.id, row.scope_id)
    .first<{ document: string }>();
  if (!scope) return null;
  const parsedScope = canonicalSupplyScope(JSON.parse(scope.document));
  const decode = (r: Row) =>
    requireSupplyHistoryRow(
      {
        sequence: r.sequence,
        id: r.id,
        scopeId: r.scope_id,
        document: JSON.parse(r.document),
      },
      parsedScope,
      row.scope_id,
    );
  const current = decode(row);
  const before = await db
    .prepare(
      'SELECT sequence,id,scope_id,document FROM imported_supply_observations WHERE owner_id=? AND project_id=? AND scope_id=? AND sequence=?',
    )
    .bind(owner, q.id, row.scope_id, current.document.previousSequence)
    .first<Row>();
  if (!before) return null;
  const previous = decode(before);
  try {
    supplyMovementInterval(current, previous, q.wallet);
  } catch {
    return null;
  }
  return { current, previous };
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to read wallet movement evidence.' }, 401);
  let q;
  try {
    const p = new URL(request.url).searchParams;
    if ([...p.keys()].some((k) => p.getAll(k).length !== 1)) throw new Error();
    q = input({
      ...Object.fromEntries(p),
      revision: Number(p.get('revision')),
    });
    if (q.mode !== 'inspect') throw new Error();
  } catch {
    return json({ error: 'Choose a saved wallet alert.' }, 400);
  }
  try {
    const db = getD1();
    const c = await context(db, user.userId, q);
    if (!c)
      return json(
        { error: 'Saved wallet alert not found or project changed.' },
        409,
      );
    const rows = await db
      .prepare(
        'SELECT id,document FROM supply_movement_evidence WHERE owner_id=? AND project_id=? AND observation_id=? AND wallet_address=? ORDER BY sequence DESC LIMIT 20',
      )
      .bind(user.userId, q.id, q.observationId, q.wallet)
      .all<{ id: string; document: string }>();
    return json({
      id: q.id,
      revision: q.revision,
      observationId: q.observationId,
      wallet: q.wallet,
      items: rows.results.map((r) => ({
        id: r.id,
        document: checkedEvidence(
          JSON.parse(r.document) as SupplyMovementEvidence,
          c,
          q.wallet,
        ),
      })),
    });
  } catch {
    return json({ error: 'Movement evidence storage unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json(
      { error: 'Sign in to inspect wallet alert transactions.' },
      401,
    );
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
  let q;
  try {
    const text = await request.text();
    if (text.length > 1500)
      return json({ error: 'Movement request too large.' }, 413);
    q = input(JSON.parse(text));
  } catch {
    return json({ error: 'Choose a saved wallet alert.' }, 400);
  }
  try {
    const db = getD1(),
      c = await context(db, user.userId, q);
    if (!c)
      return json(
        { error: 'Saved wallet alert not found or project changed.' },
        409,
      );
    if (
      q.cursor &&
      !(await db
        .prepare(
          "SELECT id FROM supply_movement_evidence WHERE owner_id=? AND project_id=? AND observation_id=? AND wallet_address=? AND json_extract(document,'$.nextCursor')=? AND COALESCE(json_extract(document,'$.indexedAddress'),wallet_address)=?",
        )
        .bind(
          user.userId,
          q.id,
          q.observationId,
          q.wallet,
          q.cursor,
          q.indexedAddress,
        )
        .first())
    )
      return json(
        { error: 'Movement cursor is not retained for this alert.' },
        400,
      );
    if (q.mode === 'inspect' && q.reuseSaved) {
      const saved = await db
        .prepare(
          "SELECT id,document FROM supply_movement_evidence WHERE owner_id=? AND project_id=? AND observation_id=? AND wallet_address=? AND COALESCE(json_extract(document,'$.indexedAddress'),wallet_address)=? AND json_extract(document,'$.requestedCursor') IS ? ORDER BY sequence DESC LIMIT 1",
        )
        .bind(
          user.userId,
          q.id,
          q.observationId,
          q.wallet,
          q.indexedAddress,
          q.cursor,
        )
        .first<{ id: string; document: string }>();
      if (saved) {
        const evidence = checkedEvidence(
          JSON.parse(saved.document),
          c,
          q.wallet,
        );
        if (
          (evidence.indexedAddress ?? q.wallet) !== q.indexedAddress ||
          evidence.requestedCursor !== q.cursor ||
          (q.cursor !== null &&
            evidence.anchor !== signatureCursor(q.cursor)!.anchor)
        )
          throw new Error('Saved page context differs.');
        return json({
          id: q.id,
          revision: q.revision,
          observationId: q.observationId,
          wallet: q.wallet,
          item: { id: saved.id, document: evidence },
        });
      }
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
        { error: 'Wait 15 seconds between supply or movement reads.' },
        429,
      );
    let evidence;
    try {
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(25000),
      ]);
      if (q.mode === 'accounts') {
        const interval = supplyMovementInterval(
          c.current,
          c.previous,
          q.wallet,
        );
        const accounts = await observeSupplyTokenAccounts(
          q.wallet,
          interval.mint,
          interval.decimals,
          interval.toSlot,
          signal,
        );
        if (!(await context(db, user.userId, q)))
          return json(
            { error: 'Project changed during token account discovery.' },
            409,
          );
        return json({
          id: q.id,
          revision: q.revision,
          observationId: q.observationId,
          wallet: q.wallet,
          accounts,
        });
      }
      evidence = await observeSupplyMovementEvidence(
        c.current,
        c.previous,
        q.wallet,
        q.cursor,
        signal,
        q.indexedAddress,
      );
      checkedEvidence(evidence, c, q.wallet);
      if ((evidence.indexedAddress ?? q.wallet) !== q.indexedAddress)
        throw new Error('Indexed address differs.');
      if (evidence.requestedCursor !== q.cursor)
        throw new Error('Requested cursor differs.');
      if (q.cursor && evidence.anchor !== signatureCursor(q.cursor)!.anchor)
        throw new Error('Requested anchor differs.');
    } catch {
      return json(
        {
          error:
            'Finalized interval or transaction evidence unavailable. Retry later; previous evidence is retained.',
        },
        502,
      );
    }
    const id = crypto.randomUUID(),
      createdAt = new Date().toISOString();
    const result = await db
      .prepare(
        'INSERT INTO supply_movement_evidence(id,owner_id,project_id,observation_id,wallet_address,document,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=?) AND EXISTS(SELECT 1 FROM imported_supply_observations WHERE owner_id=? AND project_id=? AND id=? AND sequence=?)',
      )
      .bind(
        id,
        user.userId,
        q.id,
        q.observationId,
        q.wallet,
        JSON.stringify(evidence),
        createdAt,
        user.userId,
        q.id,
        q.revision,
        user.userId,
        q.id,
        q.observationId,
        c.current.sequence,
      )
      .run();
    if (!result.meta.changes)
      return json(
        { error: 'Project changed during this inspection. Reload.' },
        409,
      );
    return json({
      id: q.id,
      revision: q.revision,
      observationId: q.observationId,
      wallet: q.wallet,
      item: { id, document: evidence },
    });
  } catch {
    return json({ error: 'Movement evidence storage unavailable.' }, 503);
  }
}
import { requireMovementClassification } from '@/lib/wallet-movement-classification';
