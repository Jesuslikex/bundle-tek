import { ensurePulseSchema } from '@/db';
import { assertSolanaAddress, createWalletChallenge, WALLET_CHALLENGE_TTL_MS } from '@/lib/wallet-verification';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json() as { address?: unknown };
    const walletAddress = assertSolanaAddress(body.address);
    const db = await ensurePulseSchema();
    const now = new Date();
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + WALLET_CHALLENGE_TTL_MS).toISOString();
    const active = await db.prepare(`SELECT COUNT(*) AS count FROM wallet_challenges
      WHERE wallet_address = ? AND used_at IS NULL AND expires_at > ?`).bind(walletAddress, issuedAt).first<{ count: number }>();
    if (Number(active?.count ?? 0) >= 5) return Response.json({ error: 'Too many active wallet challenges. Wait a few minutes and retry.' }, { status: 429 });
    const id = crypto.randomUUID();
    const message = createWalletChallenge(walletAddress, id, issuedAt);
    await db.prepare(`INSERT INTO wallet_challenges
      (id, wallet_address, message, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(id, walletAddress, message, issuedAt, expiresAt).run();
    return Response.json({ id, message, expiresAt }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to create wallet challenge' }, { status: 400 });
  }
}
