import { ensurePulseSchema } from '@/db';
import { assertSolanaAddress, verifyWalletChallenge } from '@/lib/wallet-verification';

export const dynamic = 'force-dynamic';

type ChallengeRow = { id: string; walletAddress: string; message: string; expiresAt: string; usedAt: string | null };

export async function POST(request: Request) {
  try {
    const body = await request.json() as { id?: unknown; address?: unknown; signature?: unknown };
    if (typeof body.id !== 'string' || !body.id) throw new Error('Challenge id is required');
    const walletAddress = assertSolanaAddress(body.address);
    const db = await ensurePulseSchema();
    const row = await db.prepare(`SELECT id, wallet_address AS walletAddress, message,
      expires_at AS expiresAt, used_at AS usedAt FROM wallet_challenges WHERE id = ?`)
      .bind(body.id).first<ChallengeRow>();
    if (!row || row.walletAddress !== walletAddress) return Response.json({ error: 'Wallet challenge not found' }, { status: 404 });
    if (row.usedAt) return Response.json({ error: 'Wallet challenge has already been used' }, { status: 409 });
    const now = new Date().toISOString();
    if (row.expiresAt <= now) return Response.json({ error: 'Wallet challenge expired' }, { status: 410 });
    if (!verifyWalletChallenge(row.message, body.signature, walletAddress)) return Response.json({ error: 'Wallet signature is invalid' }, { status: 401 });
    const claimed = await db.prepare(`UPDATE wallet_challenges SET used_at = ?
      WHERE id = ? AND used_at IS NULL AND expires_at > ?`).bind(now, row.id, now).run();
    if (!claimed.meta.changes) return Response.json({ error: 'Wallet challenge is no longer valid' }, { status: 409 });
    const event = { challengeId: row.id, verification: 'ed25519-detached' };
    await db.prepare(`INSERT INTO wallet_audit_events
      (id, wallet_address, network, event_type, details, created_at) VALUES (?, ?, 'devnet', 'ownership_verified', ?, ?)`)
      .bind(crypto.randomUUID(), walletAddress, JSON.stringify(event), now).run();
    return Response.json({ verified: true, address: walletAddress, verifiedAt: now }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Wallet verification failed' }, { status: 400 });
  }
}
