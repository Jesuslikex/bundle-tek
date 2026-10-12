import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { validateBalanceRequest } from '@/lib/wallet-balances';
import { observeWarmupHistory } from '@/lib/wallet-warmup-history';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to check warmup history.' }, 401);
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
  let input;
  try {
    const text = await request.text();
    if (text.length > 4000) return json({ error: 'Request too large.' }, 413);
    input = validateBalanceRequest(JSON.parse(text));
    if (input.addresses.length > 20)
      throw new Error('Check up to 20 wallets at once.');
  } catch {
    return json(
      { error: 'Choose 1 to 20 distinct public wallets on a supported chain.' },
      400,
    );
  }
  const owner = user.userId;
  const readOwned = (db: D1Database) =>
    db
      .prepare(
        'SELECT address,revision FROM workspace_wallets WHERE owner_id=? AND chain=? AND archived=0 AND address IN (SELECT value FROM json_each(?))',
      )
      .bind(owner, input.chain, JSON.stringify(input.addresses))
      .all<{ address: string; revision: number }>();
  let db: D1Database, wallets: Array<{ address: string; revision: number }>;
  try {
    db = getD1();
    wallets = (await readOwned(db)).results;
    if (wallets.length !== input.addresses.length)
      return json({ error: 'Select active saved wallets.' }, 404);
    const now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO wallet_balance_gates (owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
      )
      .bind(owner, now + 15000, now)
      .run();
    if (!gate.meta.changes)
      return json({ error: 'Wait 15 seconds between wallet reads.' }, 429);
  } catch {
    return json({ error: 'Wallet storage unavailable.' }, 503);
  }
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25000)]);
  const results: Array<{
    address: string;
    observation?: Awaited<ReturnType<typeof observeWarmupHistory>>;
    error?: string;
  }> = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, input.addresses.length) }, async () => {
      while (index < input.addresses.length && !signal.aborted) {
        const address = input.addresses[index++];
        try {
          results.push({
            address,
            observation: await observeWarmupHistory(
              input.chain,
              address,
              signal,
            ),
          });
        } catch {
          results.push({
            address,
            error: 'History provider unavailable. No readiness conclusion.',
          });
        }
      }
    }),
  );
  for (const address of input.addresses)
    if (!results.some((r) => r.address === address))
      results.push({ address, error: 'History check timed out.' });
  try {
    const current = (await readOwned(db)).results;
    if (
      current.length !== wallets.length ||
      wallets.some(
        (w) =>
          !current.some(
            (c) => c.address === w.address && c.revision === w.revision,
          ),
      )
    )
      return json({ error: 'Wallet selection changed. Check again.' }, 409);
  } catch {
    return json({ error: 'Wallet storage unavailable.' }, 503);
  }
  return json({
    chain: input.chain,
    results: input.addresses.map((a) => results.find((r) => r.address === a)),
  });
}
