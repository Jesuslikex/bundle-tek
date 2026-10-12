import { ensurePulseSchema } from '@/db';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { walletRequest } from '@/lib/wallet-request';
import {
  assertSolanaAddress,
  createWalletChallenge,
  WALLET_CHALLENGE_TTL_MS,
} from '@/lib/wallet-verification';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return Response.json(
      { error: 'Sign in to verify a wallet.' },
      { status: 401 },
    );
  let walletAddress: string;
  try {
    walletAddress = assertSolanaAddress((await walletRequest(request)).address);
  } catch {
    return Response.json(
      { error: 'Invalid wallet challenge request.' },
      { status: 400 },
    );
  }
  try {
    const db = await ensurePulseSchema();
    const now = new Date();
    const issuedAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + WALLET_CHALLENGE_TTL_MS,
    ).toISOString();
    const id = crypto.randomUUID();
    const origin = new URL(request.url).origin;
    const message =
      createWalletChallenge(walletAddress, id, issuedAt) +
      `\nOrigin: ${origin}\nAccount: ${user.userId}`;
    const result = await db
      .prepare(`INSERT INTO wallet_challenges
      (id, owner_id, origin, wallet_address, message, issued_at, expires_at)
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM wallet_challenges WHERE owner_id=? AND used_at IS NULL AND expires_at>?)<50
      AND (SELECT COUNT(*) FROM wallet_challenges WHERE owner_id=? AND wallet_address=? AND used_at IS NULL AND expires_at>?)<5
      AND (SELECT COUNT(*) FROM wallet_challenges WHERE owner_id=?)<10000`)
      .bind(
        id,
        user.userId,
        origin,
        walletAddress,
        message,
        issuedAt,
        expiresAt,
        user.userId,
        issuedAt,
        user.userId,
        walletAddress,
        issuedAt,
        user.userId,
      )
      .run();
    if (!result.meta.changes)
      return Response.json(
        {
          error: 'Wallet challenge limit reached. Try again later.',
        },
        { status: 429 },
      );
    return Response.json(
      { id, message, expiresAt },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return Response.json(
      { error: 'Wallet challenge storage temporarily unavailable.' },
      { status: 503 },
    );
  }
}
