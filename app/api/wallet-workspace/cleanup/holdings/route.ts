import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { balanceRpc } from '@/lib/wallet-balances';
import { getSolanaIndexerRpcEndpoint } from '@/lib/solana-rpc';
import type { HoldingsSnapshot } from '@/lib/wallet-holdings';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/**
 * Per-wallet balance of the cleanup token plus its supply, so the panel can
 * show Proxima's share-of-supply column. Without an explicit `mint` the token
 * the most wallets hold wins (ties broken by the largest total), which is the
 * token a batch would sell anyway.
 */
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to view token supply.' }, 401);
  const asked = new URL(request.url).searchParams.get('mint') ?? '';
  if (asked && !MINT.test(asked))
    return json({ error: 'Choose a valid token mint.' }, 400);
  let rows: { address: string; document: string | null }[];
  try {
    const db = getD1();
    const result = await db
      .prepare(
        `SELECT w.address, s.document FROM workspace_wallets w
         LEFT JOIN wallet_holdings_snapshots s
           ON s.owner_id=w.owner_id AND s.chain=w.chain AND s.address=w.address
         WHERE w.owner_id=? AND w.chain='Solana' AND w.archived=0`,
      )
      .bind(user.userId)
      .all<{ address: string; document: string | null }>();
    rows = result.results ?? [];
  } catch {
    return json({ error: 'Holdings storage temporarily unavailable.' }, 503);
  }
  const held = new Map<string, Map<string, string>>();
  for (const row of rows) {
    if (!row.document) continue;
    let snapshot: HoldingsSnapshot;
    try {
      snapshot = JSON.parse(row.document) as HoldingsSnapshot;
    } catch {
      continue;
    }
    for (const holding of snapshot.holdings ?? []) {
      const byWallet = held.get(holding.mint) ?? new Map<string, string>();
      byWallet.set(row.address, holding.raw);
      held.set(holding.mint, byWallet);
    }
  }
  let mint = asked;
  if (!mint) {
    let best = -1;
    let bestTotal = -1;
    for (const [candidate, byWallet] of held) {
      const total = [...byWallet.values()].reduce(
        (sum, raw) => sum + Number(raw),
        0,
      );
      if (
        byWallet.size > best ||
        (byWallet.size === best && total > bestTotal)
      ) {
        best = byWallet.size;
        bestTotal = total;
        mint = candidate;
      }
    }
  }
  if (!mint) return json({ mint: null, supplyRaw: '0', decimals: 0, balances: {} });
  const balances: Record<string, string> = {};
  for (const [address, raw] of held.get(mint) ?? []) balances[address] = raw;
  let supplyRaw = '0';
  let decimals = 0;
  try {
    const supply = (await balanceRpc(
      getSolanaIndexerRpcEndpoint(),
      'getTokenSupply',
      [mint, { commitment: 'confirmed' }],
      AbortSignal.any([request.signal, AbortSignal.timeout(12000)]),
      fetch,
      262_144,
    )) as { value?: { amount?: string; decimals?: number } };
    supplyRaw = supply.value?.amount ?? '0';
    decimals = supply.value?.decimals ?? 0;
  } catch {
    return json({ error: 'Token supply provider unavailable.', mint, balances });
  }
  return json({ mint, supplyRaw, decimals, balances });
}
