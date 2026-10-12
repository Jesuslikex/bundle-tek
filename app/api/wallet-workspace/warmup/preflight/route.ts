import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { inspectWarmupPreflight } from '@/lib/wallet-warmup-preflight';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to check warmup preflight.' }, 401);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin request rejected.' }, 403);
  let input: { id: string; revision: number };
  try {
    const text = await request.text();
    if (text.length > 500) return json({ error: 'Request too large.' }, 413);
    input = JSON.parse(text);
    if (
      !input ||
      typeof input.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(input.id) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1
    )
      throw new Error();
  } catch {
    return json({ error: 'Choose a saved warmup plan revision.' }, 400);
  }
  let db: D1Database;
  let document: SavedWarmup['document'];
  const read = () =>
    db
      .prepare(`SELECT document FROM wallet_warmup_plans p WHERE owner_id=? AND id=? AND revision=? AND archived=0 AND
    (SELECT COUNT(*) FROM json_each(json_extract(p.document,'$.walletRevisions')) j JOIN workspace_wallets w ON w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision') WHERE w.owner_id=p.owner_id AND w.chain=json_extract(p.document,'$.chain') AND w.archived=0)=json_array_length(json_extract(p.document,'$.addresses'))`)
      .bind(user.userId, input.id, input.revision)
      .first<{ document: string }>();
  try {
    db = getD1();
    const row = await read();
    if (!row)
      return json(
        {
          error:
            'Saved plan or wallet revisions changed, or plan is archived. Reopen and save current wallets first.',
        },
        409,
      );
    document = JSON.parse(row.document);
    const now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
      )
      .bind(user.userId, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      return json({ error: 'Wait 15 seconds between wallet reads.' }, 429);
  } catch {
    return json({ error: 'Warmup storage unavailable.' }, 503);
  }
  try {
    const report = await inspectWarmupPreflight(
      document,
      AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
    );
    if (!(await read()))
      return json(
        {
          error: 'Saved plan or wallets changed during preflight. Check again.',
        },
        409,
      );
    return json({ id: input.id, revision: input.revision, report });
  } catch {
    return json(
      { error: 'Warmup preflight unavailable. No execution clearance.' },
      502,
    );
  }
}
