import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  address,
  getBase64Encoder,
  getTransactionDecoder,
  getTransactionEncoder,
} from '@solana/kit';
import type { WarmupSigningReview } from './warmup-signing';
export function verifyExactSwapSignature(
  review: WarmupSigningReview,
  transaction: string,
) {
  if (typeof transaction !== 'string' || transaction.length > 1644)
    throw new Error('Signed packet required.');
  const bytes = getBase64Encoder().encode(transaction),
    tx = getTransactionDecoder().decode(bytes);
  const signature = tx.signatures[address(review.wallet)];
  const unsigned = getTransactionEncoder().encode({
      ...tx,
      signatures: { [review.wallet]: null },
    }),
    approved = getBase64Encoder().encode(review.transaction);
  if (
    bytes.length > 1232 ||
    Object.keys(tx.signatures).length !== 1 ||
    !signature ||
    unsigned.length !== approved.length ||
    unsigned.some((b, i) => b !== approved[i]) ||
    !nacl.sign.detached.verify(
      Uint8Array.from(tx.messageBytes),
      Uint8Array.from(signature),
      bs58.decode(review.wallet),
    )
  )
    throw new Error('Signed packet differs.');
  return bs58.encode(signature);
}
