import { validatedSwapFailure, type SwapFailureReceipt } from './swap-failure';
import {
  address,
  getBase64Encoder,
  getBase64Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
  type SignatureBytes,
} from '@solana/kit';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { WarmupSigningReview } from './warmup-signing';
export type WarmupApprovalHistoryRow = {
  id: string;
  preparationId: string;
  planId: string;
  planRevision: number;
  wallet: string;
  cycle: number;
  side: 'Buy' | 'Sell';
  state:
    | 'awaiting_signature'
    | 'signed'
    | 'submitted'
    | 'cancelled'
    | 'failed'
    | 'finalized';
  signature: string | null;
  failureReceipt?: SwapFailureReceipt | null;
  createdAt: string;
  updatedAt: string;
  document: WarmupSigningReview;
};
// This restores a public registered signature, without asking any wallet to sign or broadcasting.
// Expiry is intentionally allowed for receipt recovery. Submission keeps its existing expiry guard.
export async function restoreRegisteredWarmupPacket(
  review: WarmupSigningReview,
  signature: string,
) {
  if (review.network !== 'mainnet')
    throw new Error('Approval network differs.');
  const bytes = getBase64Encoder().encode(review.transaction);
  if (bytes.length > 1232)
    throw new Error('Approved packet exceeds the size limit.');
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
  );
  if (
    Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    ) !== review.sha256
  )
    throw new Error('Approved packet changed.');
  const tx = getTransactionDecoder().decode(bytes),
    message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes),
    canonical = getTransactionEncoder().encode(tx),
    sig = bs58.decode(signature);
  if (
    message.version !== 0 ||
    message.header.numSignerAccounts !== 1 ||
    message.staticAccounts[0] !== review.wallet ||
    Object.keys(tx.signatures).length !== 1 ||
    Object.values(tx.signatures).some((value) =>
      value?.some((byte) => byte !== 0),
    ) ||
    canonical.length !== bytes.length ||
    canonical.some((byte, index) => byte !== bytes[index]) ||
    sig.length !== 64 ||
    bs58.encode(sig) !== signature ||
    !nacl.sign.detached.verify(
      Uint8Array.from(tx.messageBytes),
      sig,
      bs58.decode(review.wallet),
    )
  )
    throw new Error('Registered signature or approved message differs.');
  return {
    signature,
    transaction: getBase64Decoder().decode(
      getTransactionEncoder().encode({
        ...tx,
        signatures: { [address(review.wallet)]: sig as SignatureBytes },
      }),
    ),
  };
}

export function validatedWarmupFailure(row: {
  state: string;
  signature: string | null;
  document: WarmupSigningReview;
  failureReceipt?: unknown;
}) {
  if (row.failureReceipt === undefined || row.failureReceipt === null)
    return null;
  if (row.state !== 'failed' || !row.signature)
    throw new Error('Warmup failure context differs.');
  return validatedSwapFailure(row.failureReceipt, row.document, row.signature);
}
