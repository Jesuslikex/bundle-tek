import { env } from '@/lib/server-env';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { quoteWarmupBuy, WarmupQuoteError } from '@/lib/warmup-swap-quote';
import type { SavedWarmup } from '@/lib/wallet-warmup-storage';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to quote a saved warmup.' }, 401);
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
  let input: { id: string; revision: number; cycle?: number };
  try {
    const text = await request.text();
    if (text.length > 500) return json({ error: 'Request too large.' }, 413);
    input = JSON.parse(text);
    if (
      !input ||
      typeof input.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(input.id) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      (input.cycle !== undefined &&
        (!Number.isSafeInteger(input.cycle) ||
          input.cycle < 1 ||
          input.cycle > 20))
    )
      throw new Error();
  } catch {
    return json({ error: 'Choose a saved warmup revision.' }, 400);
  }
  let db: D1Database;
  const read = () =>
    db
      .prepare(
        `SELECT document FROM wallet_warmup_plans p WHERE owner_id=? AND id=? AND revision=? AND archived=0 AND (SELECT COUNT(*) FROM json_each(json_extract(p.document,'$.walletRevisions')) j JOIN workspace_wallets w ON w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision') WHERE w.owner_id=p.owner_id AND w.chain=json_extract(p.document,'$.chain') AND w.archived=0)=json_array_length(json_extract(p.document,'$.addresses'))`,
      )
      .bind(user.userId, input.id, input.revision)
      .first<{ document: string }>();
  let document: SavedWarmup['document'];
  try {
    db = getD1();
    const row = await read();
    if (!row)
      return json(
        {
          error: 'Saved plan or wallet revisions changed, or plan is archived.',
        },
        409,
      );
    document = JSON.parse(row.document);
    if ((input.cycle ?? 1) > document.cycles)
      return json({ error: 'Choose a cycle in the saved plan.' }, 400);
    const key = (env as unknown as Record<string, unknown>).JUPITER_API_KEY;
    if (typeof key !== 'string' || !key)
      return json({ error: 'Swap quote service is not configured.' }, 503);
    const now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
      )
      .bind(user.userId, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      return json({ error: 'Wait 15 seconds between wallet reads.' }, 429);
    const quote = await quoteWarmupBuy(
      document,
      key,
      AbortSignal.any([request.signal, AbortSignal.timeout(12000)]),
      fetch,
      input.cycle ?? 1,
    );
    if (!(await read()))
      return json(
        { error: 'Saved plan or wallets changed during quote.' },
        409,
      );
    if (Date.parse(quote.expiresAt) <= Date.now())
      return json({ error: 'Quote expired. Refresh.' }, 409);
    return json({ id: input.id, revision: input.revision, quote });
  } catch (e) {
    return json(
      {
        error:
          e instanceof WarmupQuoteError
            ? e.message
            : 'Swap quote unavailable. No execution clearance.',
      },
      502,
    );
  }
}
