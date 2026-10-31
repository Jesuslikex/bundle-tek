import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { getSolanaIndexerRpcEndpoint } from '@/lib/solana-rpc';
import { balanceRpc } from '@/lib/wallet-balances';
import { readPortfolioHoldings } from '@/lib/portfolio-holdings';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** Read-only portfolio holdings. Nothing is signed, sent or stored. */
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to see your portfolio.' }, 401);
  try {
    const db = getD1(),
      now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
      )
      .bind(JSON.stringify(['portfolio-v1', user.userId]), now + 10000, now)
      .run();
    if (!gate.meta.changes)
      return json({ error: 'Wait 10 seconds between portfolio reads.' }, 429);
    const endpoint = getSolanaIndexerRpcEndpoint(),
      url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      return json({ error: 'Portfolio RPC is not configured.' }, 503);
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(25000),
    ]);
    return json(
      await readPortfolioHoldings(db, user.userId, (method, params) => {
        if (method !== 'getMultipleAccounts')
          throw new Error('Portfolio reads are read-only.');
        return balanceRpc(endpoint, method, params, signal, fetch, 2097152);
      }),
    );
  } catch {
    return json(
      { error: 'Portfolio balances unavailable. Nothing was signed or sent.' },
      502,
    );
  }
}
