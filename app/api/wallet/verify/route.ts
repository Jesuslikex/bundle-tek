import { ensurePulseSchema } from '@/db';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { walletRequest } from '@/lib/wallet-request';
import {
  assertSolanaAddress,
  verifyWalletChallenge,
} from '@/lib/wallet-verification';

export const dynamic = 'force-dynamic';

type ChallengeRow = {
  id: string;
  walletAddress: string;
  message: string;
  expiresAt: string;
  usedAt: string | null;
};

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return Response.json(
      { error: 'Sign in to verify a wallet.' },
      { status: 401 },
    );
  let body: Record<string, unknown>, walletAddress: string;
  try {
    body = await walletRequest(request);
    if (
      typeof body.id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        body.id,
      )
    )
      throw new Error('Invalid challenge id.');
    walletAddress = assertSolanaAddress(body.address);
  } catch {
    return Response.json(
      { error: 'Invalid wallet verification request.' },
      { status: 400 },
    );
  }
  try {
    const db = await ensurePulseSchema();
    const row = await db
      .prepare(`SELECT id, wallet_address AS walletAddress, message,
      expires_at AS expiresAt, used_at AS usedAt FROM wallet_challenges WHERE id = ? AND owner_id=? AND origin=?`)
      .bind(body.id as string, user.userId, new URL(request.url).origin)
      .first<ChallengeRow>();
    if (!row || row.walletAddress !== walletAddress)
      return Response.json(
        { error: 'Wallet challenge not found' },
        { status: 404 },
      );
    if (row.usedAt)
      return Response.json(
        { error: 'Wallet challenge has already been used' },
        { status: 409 },
      );
    const now = new Date().toISOString();
    if (row.expiresAt <= now)
      return Response.json(
        { error: 'Wallet challenge expired' },
        { status: 410 },
      );
    if (!verifyWalletChallenge(row.message, body.signature, walletAddress))
      return Response.json(
        { error: 'Wallet signature is invalid' },
        { status: 401 },
      );
    const nonce = crypto.randomUUID();
    const event = { challengeId: row.id, verification: 'ed25519-detached' };
    const results = await db.batch([
      db
        .prepare(
          `UPDATE wallet_challenges SET used_at=?, claim_nonce=? WHERE id=? AND owner_id=? AND used_at IS NULL AND expires_at>?`,
        )
        .bind(now, nonce, row.id, user.userId, now),
      db
        .prepare(`INSERT INTO wallet_audit_events (id,owner_id,wallet_address,network,event_type,details,created_at)
        SELECT ?,?,?,'devnet','ownership_verified',?,? WHERE EXISTS
        (SELECT 1 FROM wallet_challenges WHERE id=? AND owner_id=? AND claim_nonce=? AND used_at=?)`)
        .bind(
          crypto.randomUUID(),
          user.userId,
          walletAddress,
          JSON.stringify(event),
          now,
          row.id,
          user.userId,
          nonce,
          now,
        ),
    ]);
    if (!results[0].meta.changes || !results[1].meta.changes)
      return Response.json(
        { error: 'Wallet challenge is no longer valid' },
        { status: 409 },
      );
    return Response.json(
      { verified: true, address: walletAddress, verifiedAt: now },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return Response.json(
      { error: 'Wallet verification storage temporarily unavailable.' },
      { status: 503 },
    );
  }
}
