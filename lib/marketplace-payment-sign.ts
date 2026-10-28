import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { VaultSession } from './browser-wallet-vault';

// Client half of the payment: the server prepared the message, the vault signs
// it here. Kept apart from marketplace-payment.ts so the browser never pulls the
// server-only RPC module.
export function signMarketplacePayment(
  session: VaultSession,
  wallet: string,
  transaction: string,
) {
  // The prepared packet is the bare message; a signed one would already carry a
  // signature section.
  const bytes = Uint8Array.from(Buffer.from(transaction, 'base64'));
  const message = bytes.length > 200 ? bytes.subarray(65) : bytes;
  const entry = session.payload.wallets.find(
    (w) => w.family === 'solana' && w.address === wallet,
  );
  if (!entry || !/^[a-f0-9]{64}$/.test(entry.seed))
    throw Error('The paying wallet is not in this vault.');
  const seed = Uint8Array.from(entry.seed.match(/../g)!, (s) =>
    parseInt(s, 16),
  );
  const pair = nacl.sign.keyPair.fromSeed(seed);
  try {
    if (bs58.encode(pair.publicKey) !== wallet)
      throw Error('The vault key does not match the paying wallet.');
    const signature = nacl.sign.detached(message, pair.secretKey);
    return {
      signature: bs58.encode(signature),
      transaction: Buffer.from(
        Uint8Array.from([1, ...signature, ...message]),
      ).toString('base64'),
    };
  } finally {
    seed.fill(0);
    pair.secretKey.fill(0);
  }
}
