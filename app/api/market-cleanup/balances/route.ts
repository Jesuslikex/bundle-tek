import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { getSolanaIndexerRpcEndpoint } from '@/lib/solana-rpc';
import { balanceRpc } from '@/lib/wallet-balances';
import { UUID } from '@/lib/wallet-operation';
import { walletAddress } from '@/lib/wallet-workspace';
import { readCleanupBalances } from '@/lib/market-cleanup-balances';
import { MARKET_CLEANUP_MAX_WALLETS } from '@/lib/market-cleanup';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(status === 429 ? { 'retry-after': '2' } : {}),
    },
  });

/** Read-only SOL and coin balances of the user's own Cleanup wallets. */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to read Cleanup wallets.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Use this site for Cleanup.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  let input: { projectId: string; revision: number; wallets: string[] };
  try {
    const text = await request.text();
    if (text.length > 4000) return json({ error: 'Request too large.' }, 413);
    const body = JSON.parse(text) as Record<string, unknown>;
    if (
      !body ||
      Object.keys(body).sort().join(',') !== 'projectId,revision,wallets' ||
      typeof body.projectId !== 'string' ||
      !UUID.test(body.projectId) ||
      !Number.isSafeInteger(body.revision) ||
      (body.revision as number) < 1 ||
      !Array.isArray(body.wallets) ||
      !body.wallets.length ||
      body.wallets.length > MARKET_CLEANUP_MAX_WALLETS * 2
    )
      throw new Error();
    const wallets = body.wallets.map((w) => walletAddress(w, 'Solana'));
    if (new Set(wallets).size !== wallets.length) throw new Error();
    input = {
      projectId: body.projectId,
      revision: body.revision as number,
      wallets,
    };
  } catch {
    return json({ error: 'Choose a current project and its wallets.' }, 400);
  }
  try {
    const db = getD1();
    const project = await db
      .prepare(
        "SELECT document FROM imported_token_projects WHERE owner_id=? AND id=? AND revision=? AND chain='Solana' AND archived=0",
      )
      .bind(user.userId, input.projectId, input.revision)
      .first<{ document: string }>();
    if (!project)
      return json({ error: 'Project changed or is archived. Reload it.' }, 409);
    const owned = await db
      .prepare(
        "SELECT count(*) AS n FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND archived=0 AND address IN (SELECT value FROM json_each(?))",
      )
      .bind(user.userId, JSON.stringify(input.wallets))
      .first<{ n: number }>();
    if (owned?.n !== input.wallets.length)
      return json(
        { error: 'Every Cleanup wallet must be a saved, active wallet.' },
        409,
      );
    const now = Date.now();
    const gate = await db
      .prepare(
        'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
      )
      .bind(
        JSON.stringify(['market-cleanup-balances-v1', user.userId]),
        now + 1500,
        now,
      )
      .run();
    if (!gate.meta.changes)
      return json({ error: 'Cleanup is already reading. Wait a moment.' }, 429);
    const endpoint = getSolanaIndexerRpcEndpoint(),
      url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      return json({ error: 'Cleanup RPC is not configured.' }, 503);
    const mint = (
      JSON.parse(project.document) as { token: { address: string } }
    ).token.address;
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(20000),
    ]);
    const balances = await readCleanupBalances(
      (method, params, s) => {
        if (method !== 'getMultipleAccounts')
          throw new Error('Cleanup balances are read-only.');
        return balanceRpc(endpoint, method, params, s, fetch, 2097152);
      },
      walletAddress(mint, 'Solana'),
      input.wallets,
      signal,
    );
    return json({ balances });
  } catch {
    return json(
      { error: 'Cleanup balances unavailable. Nothing was signed or sent.' },
      502,
    );
  }
}
