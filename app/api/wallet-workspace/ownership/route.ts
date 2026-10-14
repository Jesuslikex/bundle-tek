import { recoverMessageAddress, type Hex } from 'viem';
import { verifySolanaSignature } from '@/lib/solana-signature';
import bs58 from 'bs58';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { EVM_NETWORKS } from '@/lib/evm-network';
import { walletAddress, walletChain } from '@/lib/wallet-workspace';
import { ownershipMessage } from '@/lib/wallet-ownership-message';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const active = `EXISTS (SELECT 1 FROM workspace_wallets w
 WHERE w.owner_id=? AND w.chain=? AND w.address=? AND w.archived=0)`;
type Challenge = {
  message: string;
  expires_at: string;
  used_at: string | null;
};
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to verify wallet ownership.' }, 401);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  const origin = new URL(request.url).origin;
  if (request.headers.get('origin') && request.headers.get('origin') !== origin)
    return json({ error: 'Cross-origin write rejected.' }, 403);
  let storage = false;
  try {
    const text = await request.text();
    if (text.length > 5_000) return json({ error: 'Request too large.' }, 413);
    const body = JSON.parse(text);
    const chain = walletChain(body.chain);
    const address = walletAddress(body.address, chain);
    if (!['challenge', 'verify'].includes(body.action))
      throw new Error('Choose a verification action.');
    const db = getD1(),
      owner = user.userId,
      now = new Date().toISOString();
    storage = true;
    const eligible = await db
      .prepare(`SELECT 1 AS eligible WHERE ${active}`)
      .bind(owner, chain, address)
      .first();
    if (!eligible)
      return json(
        { error: 'Save this address as an active wallet before verifying.' },
        409,
      );
    if (body.action === 'challenge') {
      const id = crypto.randomUUID();
      const issuedAt = new Date().toISOString();
      const expiresAt = new Date(Date.parse(issuedAt) + 300_000).toISOString();
      const message = ownershipMessage(
        origin,
        chain,
        address,
        id,
        issuedAt,
        expiresAt,
      );
      const result = await db.batch([
        db
          .prepare(
            'DELETE FROM wallet_ownership_challenges WHERE owner_id=? AND expires_at<=?',
          )
          .bind(owner, now),
        db
          .prepare(`INSERT INTO wallet_ownership_challenges (id,owner_id,chain,address,message,expires_at)
          SELECT ?,?,?,?,?,? WHERE ${active}
          AND (SELECT COUNT(*) FROM wallet_ownership_challenges WHERE owner_id=?)<50
          AND (SELECT COUNT(*) FROM wallet_ownership_challenges WHERE owner_id=? AND chain=? AND address=?)<5`)
          .bind(
            id,
            owner,
            chain,
            address,
            message,
            expiresAt,
            owner,
            chain,
            address,
            owner,
            owner,
            chain,
            address,
          ),
      ]);
      if (!result[1].meta.changes)
        return json(
          {
            error:
              'Too many verification requests, or the folder changed. Retry in five minutes.',
          },
          429,
        );
      return json({
        id,
        chain,
        chainId: chain === 'Solana' ? null : EVM_NETWORKS[chain].id,
        address,
        message,
        issuedAt,
        expiresAt,
      });
    }
    storage = false;
    if (
      typeof body.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        body.id,
      ) ||
      typeof body.signature !== 'string' ||
      !(chain === 'Solana'
        ? /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(body.signature)
        : /^0x[0-9a-f]{130}$/i.test(body.signature))
    )
      throw new Error('Unsupported ownership signature.');
    storage = true;
    const row = await db
      .prepare(
        'SELECT message,expires_at,used_at FROM wallet_ownership_challenges WHERE owner_id=? AND id=? AND chain=? AND address=?',
      )
      .bind(owner, body.id, chain, address)
      .first<Challenge>();
    if (!row)
      return json({ error: 'Verification challenge unavailable.' }, 404);
    if (row.used_at)
      return json({ error: 'Verification challenge already used.' }, 409);
    if (row.expires_at <= now)
      return json(
        { error: 'Verification expired. Request a new message.' },
        410,
      );
    if (row.message.split('\n')[1] !== `Origin: ${origin}`)
      return json(
        { error: 'Verification challenge belongs to another site.' },
        400,
      );
    let valid = false;
    try {
      if (chain === 'Solana') {
        const signature = bs58.decode(body.signature);
        valid =
          signature.length === 64 &&
          verifySolanaSignature(
            new TextEncoder().encode(row.message),
            signature,
            bs58.decode(address),
          );
      } else {
        valid =
          (await recoverMessageAddress({
            message: row.message,
            signature: body.signature as Hex,
          })) === address;
      }
    } catch {
      return json({ error: 'Ownership signature did not verify.' }, 400);
    }
    if (!valid)
      return json({ error: 'Ownership signature did not verify.' }, 400);
    // A fresh nonce links consumption and proof insertion, including same-clock races.
    const claim = crypto.randomUUID(),
      verifiedAt = new Date().toISOString();
    const result = await db.batch([
      db
        .prepare(
          `UPDATE wallet_ownership_challenges SET used_at=?,claim_id=? WHERE owner_id=? AND id=? AND chain=? AND address=? AND used_at IS NULL AND expires_at>? AND ${active}`,
        )
        .bind(
          verifiedAt,
          claim,
          owner,
          body.id,
          chain,
          address,
          verifiedAt,
          owner,
          chain,
          address,
        ),
      db
        .prepare(`INSERT INTO wallet_ownership_proofs (owner_id,chain,address,verified_at,challenge_id)
        SELECT owner_id,chain,address,used_at,id FROM wallet_ownership_challenges WHERE owner_id=? AND id=? AND claim_id=?
        ON CONFLICT(owner_id,chain,address) DO UPDATE SET verified_at=excluded.verified_at,challenge_id=excluded.challenge_id`)
        .bind(owner, body.id, claim),
    ]);
    if (!result[0].meta.changes || !result[1].meta.changes)
      return json(
        { error: 'Wallet or challenge changed. Request a new message.' },
        409,
      );
    return json({ chain, address, verifiedAt });
  } catch (error) {
    return json(
      {
        error: storage
          ? 'Wallet verification temporarily unavailable.'
          : error instanceof Error
            ? error.message
            : 'Invalid verification request.',
      },
      storage ? 503 : 400,
    );
  }
}
