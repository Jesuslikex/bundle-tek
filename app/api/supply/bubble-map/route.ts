import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { findFunders } from '@/lib/bubble-map-funders';
import { getSolanaHolderRpcEndpoint, rpcCall } from '@/lib/solana-rpc';
import { SOLANA_MAINNET_GENESIS } from '@/lib/wallet-balances';
import { walletAddress } from '@/lib/wallet-workspace';

export const dynamic = 'force-dynamic';
// One map can cost up to ~140 paid RPC calls, so each account waits between maps.
const GAP_MS = 10_000;
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(status === 429 ? { 'retry-after': String(GAP_MS / 1000) } : {}),
    },
  });

// Read-only: looks up who first funded each holder. Nothing is signed or sent.
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to map holders.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Use this site to map holders.' }, 403);
  let addresses: string[];
  try {
    const body = (await request.json()) as { addresses?: unknown };
    if (
      !body ||
      Object.keys(body).join() !== 'addresses' ||
      !Array.isArray(body.addresses) ||
      !body.addresses.length ||
      body.addresses.length > 20
    )
      throw new Error();
    addresses = body.addresses.map((a) => walletAddress(a, 'Solana'));
    if (new Set(addresses).size !== addresses.length) throw new Error();
  } catch {
    return json(
      { error: 'Send 1 to 20 distinct Solana holder addresses.' },
      400,
    );
  }
  try {
    const now = Date.now(),
      gate = await getD1()
        .prepare(
          'INSERT INTO imported_token_project_gates(owner_id,next_allowed_at) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE imported_token_project_gates.next_allowed_at<=?',
        )
        .bind(JSON.stringify(['bubble-map-v1', user.userId]), now + GAP_MS, now)
        .run();
    if (!gate.meta.changes)
      return json({ error: 'Wait a few seconds before mapping again.' }, 429);
  } catch {
    return json({ error: 'Holder mapping temporarily unavailable.' }, 503);
  }
  try {
    const endpoint = getSolanaHolderRpcEndpoint();
    if (
      (await rpcCall(endpoint, 'getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS
    )
      throw new Error('Holder provider network differs.');
    const funders = await findFunders(addresses, (method, params) =>
      rpcCall(endpoint, method, params),
    );
    return json({ network: 'mainnet', funders });
  } catch {
    return json(
      {
        error:
          'Funding history unavailable. The holder RPC may not serve signature history.',
      },
      502,
    );
  }
}
