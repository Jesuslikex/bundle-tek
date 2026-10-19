import {
  address,
  getBase64Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type SignatureBytes,
} from '@solana/kit';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { buildStonkLaunchMessage } from './stonkfun-launch';
import type { StonkLaunchReview } from './stonkfun-launch-service';
import type { VaultSession } from './browser-wallet-vault';

/** Rebuilds the server's packet locally so the user signs exactly what the review shows. */
export async function requireStonkSigningReview(
  review: StonkLaunchReview,
  current: () => void = () => {},
) {
  current();
  if (
    !review ||
    review.format !== 'stonkfun-launch-review-v1' ||
    !Number.isFinite(Date.parse(review.expiresAt)) ||
    Date.parse(review.expiresAt) <= Date.now()
  )
    throw new Error('Launch review expired. Prepare a new review.');
  const t = review.terms,
    s = review.summary;
  if (
    review.input.payer !== t.payer ||
    review.input.mint !== t.mint ||
    review.input.devBuyRaw !== t.devBuyRaw ||
    s.devBuyRaw !== t.devBuyRaw ||
    (t.devBuyRaw === '0'
      ? review.input.minTokensOutRaw !== '0'
      : review.input.minTokensOutRaw !== s.tokensOutRaw) ||
    BigInt(s.solCostLamports) > BigInt(t.solLimitLamports)
  )
    throw new Error('Launch review summary differs from its packet.');
  const built = await buildStonkLaunchMessage(review.input);
  if (
    built.packetSha256 !== review.sha256 ||
    built.transaction !== review.transaction ||
    built.pool !== s.pool
  )
    throw new Error('Launch packet differs from its reviewed instructions.');
  current();
  return getTransactionDecoder().decode(
    Uint8Array.from(atob(review.transaction), (c) => c.charCodeAt(0)),
  );
}

export async function signStonkLaunch(
  payerSession: VaultSession,
  mintSession: VaultSession,
  review: StonkLaunchReview,
  current: () => void,
) {
  const tx = await requireStonkSigningReview(review, current);
  const signatures: Record<string, SignatureBytes> = {};
  for (const [session, key] of [
    [payerSession, review.input.payer],
    [mintSession, review.input.mint],
  ] as const) {
    const wallet = session.payload.wallets.find(
      (w) => w.family === 'solana' && w.address === key,
    );
    if (!wallet || !/^[0-9a-f]{64}$/.test(wallet.seed))
      throw new Error('Unlock the exact reviewed payer and mint keys.');
    const seed = Uint8Array.from(wallet.seed.match(/../g)!, (b) =>
      parseInt(b, 16),
    );
    const pair = nacl.sign.keyPair.fromSeed(seed);
    try {
      current();
      if (bs58.encode(pair.publicKey) !== key)
        throw new Error('Launch key identity differs.');
      signatures[address(key)] = nacl.sign.detached(
        Uint8Array.from(tx.messageBytes),
        pair.secretKey,
      ) as SignatureBytes;
    } finally {
      seed.fill(0);
      pair.secretKey.fill(0);
    }
  }
  current();
  if (Date.parse(review.expiresAt) <= Date.now())
    throw new Error('Launch review expired. Prepare a new review.');
  return {
    transaction: getBase64Decoder().decode(
      getTransactionEncoder().encode({ ...tx, signatures }),
    ),
    signature: bs58.encode(signatures[review.input.payer]),
  };
}
