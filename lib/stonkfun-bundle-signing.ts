import {
  address,
  getBase64Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type SignatureBytes,
} from '@solana/kit';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { StonkBundleReview } from './stonkfun-bundle-service';
import {
  verifyStonkBundleReview,
  verifyStonkBundleSigned,
} from './stonkfun-bundle';
import type { VaultSession } from './browser-wallet-vault';

/**
 * Signs the reviewed holder buy and Jito tip packets in the browser. Every
 * packet is rebuilt locally from the review first, so the wallets sign exactly
 * what the review shows. The create packet is signed separately.
 */
export async function signStonkBundlePackets(
  session: VaultSession,
  review: StonkBundleReview,
  current: () => void = () => {},
) {
  current();
  if (Date.parse(review.expiresAt) <= Date.now())
    throw new Error('Bundle review expired. Recover the saved launch.');
  const built = await verifyStonkBundleReview(review);
  current();
  const signed: string[] = [];
  for (const packet of built.packets) {
    const tx = getTransactionDecoder().decode(
      Uint8Array.from(atob(packet.transaction), (c) => c.charCodeAt(0)),
    );
    const signatures: Record<string, SignatureBytes> = {};
    for (const key of packet.signers) {
      const wallet = session.payload.wallets.find(
        (w) => w.family === 'solana' && w.address === key,
      );
      if (!wallet || !/^[0-9a-f]{64}$/.test(wallet.seed))
        throw new Error(
          `Import bundle wallet ${key.slice(0, 4)}…${key.slice(-4)} into your browser wallet vault first.`,
        );
      const seed = Uint8Array.from(wallet.seed.match(/../g)!, (b) =>
        parseInt(b, 16),
      );
      const pair = nacl.sign.keyPair.fromSeed(seed);
      try {
        current();
        if (bs58.encode(pair.publicKey) !== key)
          throw new Error('Bundle wallet identity differs.');
        signatures[address(key)] = nacl.sign.detached(
          Uint8Array.from(tx.messageBytes),
          pair.secretKey,
        ) as SignatureBytes;
      } finally {
        seed.fill(0);
        pair.secretKey.fill(0);
      }
    }
    signed.push(
      getBase64Decoder().decode(
        getTransactionEncoder().encode({
          ...tx,
          signatures: { ...tx.signatures, ...signatures },
        }),
      ),
    );
  }
  verifyStonkBundleSigned(built.packets, signed);
  current();
  return signed;
}
