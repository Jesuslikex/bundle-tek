import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { walletAddress } from '@/lib/wallet-workspace';
import {
  MAX_SEND_SOURCES,
  tokenSendSnapshot,
} from '@/lib/token-send-snapshot-server';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

/** Read-only: mint supply and source balances for planning a send. Every transfer is still prepared and approved through withdrawals. */
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to plan a send.' }, 401);
  let mint: string, wallets: string[];
  try {
    const body = await walletRequest(request, 4096);
    mint = walletAddress(body.mint, 'Solana');
    if (
      !Array.isArray(body.wallets) ||
      body.wallets.length < 1 ||
      body.wallets.length > MAX_SEND_SOURCES
    )
      throw new Error();
    wallets = body.wallets.map((w) => walletAddress(w, 'Solana'));
    if (new Set(wallets).size !== wallets.length || wallets.includes(mint))
      throw new Error();
  } catch {
    return json(
      {
        error: `Choose a token mint and 1 to ${MAX_SEND_SOURCES} different source wallets.`,
      },
      400,
    );
  }
  try {
    const owned = await getD1()
      .prepare(
        `SELECT address FROM workspace_wallets WHERE owner_id=? AND chain='Solana' AND archived=0 AND address IN (${wallets.map(() => '?').join(',')})`,
      )
      .bind(user.userId, ...wallets)
      .all<{ address: string }>();
    if (new Set(owned.results.map((r) => r.address)).size !== wallets.length)
      return json(
        { error: 'Choose current wallets from your own roster.' },
        409,
      );
  } catch {
    return json({ error: 'Wallet roster unavailable.' }, 503);
  }
  try {
    return json({
      snapshot: await tokenSendSnapshot(
        mint,
        wallets,
        AbortSignal.any([request.signal, AbortSignal.timeout(20000)]),
      ),
    });
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error && error.message
            ? error.message
            : 'Token balances unavailable.',
      },
      502,
    );
  }
}
