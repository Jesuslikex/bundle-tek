import {
  address,
  getTransactionDecoder,
  getTransactionEncoder,
  getBase64Decoder,
} from '@solana/kit-v1';
import bs58 from 'bs58';
import { verifySolanaSignature } from './solana-signature';
import {
  requirePumpLaunchGroupReview,
  type PumpLaunchGroupReview,
} from './pump-launch-group-review';
import { pumpHolderDigest } from './pump-holder-review';
const byteHash = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');

/** Pure complete signature evidence, including expired immutable reviews for recovery. Never signs, stores or sends. */
export async function verifyPumpLaunchGroupSignatures(
  supplied: PumpLaunchGroupReview,
  suppliedTransactions: string[],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const transactions = structuredClone(suppliedTransactions);
  if (
    !Array.isArray(transactions) ||
    transactions.length < 1 ||
    transactions.length > 5 ||
    transactions.some(
      (value) => typeof value !== 'string' || !value || value.length > 5464,
    )
  )
    throw new Error('Complete signed group encoding or packet count differs.');
  const {
    review,
    built,
    transactions: unsigned,
  } = await requirePumpLaunchGroupReview(supplied, false);
  if (transactions.length !== built.packets.length)
    throw new Error('Every exact signed group packet is required.');
  const packets = [];
  for (const [index, encoded] of transactions.entries()) {
    signal?.throwIfAborted();
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)),
      tx = getTransactionDecoder().decode(bytes);
    if (
      bytes.length > 4096 ||
      btoa(atob(encoded)) !== encoded ||
      getBase64Decoder().decode(getTransactionEncoder().encode(tx)) !==
        encoded ||
      getBase64Decoder().decode(tx.messageBytes) !==
        getBase64Decoder().decode(unsigned[index].messageBytes) ||
      JSON.stringify(Object.keys(tx.signatures).sort()) !==
        JSON.stringify([...built.packets[index].requiredSigners].sort())
    )
      throw new Error(
        'Signed group packet message, order or signer set differs.',
      );
    for (const signer of built.packets[index].requiredSigners) {
      signal?.throwIfAborted();
      const signature = tx.signatures[address(signer)];
      if (
        !signature ||
        !verifySolanaSignature(
          Uint8Array.from(tx.messageBytes),
          Uint8Array.from(signature),
          bs58.decode(signer),
        )
      )
        throw new Error(
          'Every exact group wallet and mint signature is required.',
        );
    }
    packets.push({
      index,
      transaction: encoded,
      unsignedPacketSha256: built.packets[index].packetSha256,
      signedPacketSha256: await byteHash(bytes),
      signature: bs58.encode(
        tx.signatures[address(review.input.create.payer)]!,
      ),
      requiredSigners: [...built.packets[index].requiredSigners],
    });
  }
  const signedGroupSha256 = await pumpHolderDigest({
    reviewId: review.id,
    manifestSha256: review.manifestSha256,
    contextSha256: review.contextSha256,
    packets: packets.map(
      ({ index, unsignedPacketSha256, signedPacketSha256, signature }) => ({
        index,
        unsignedPacketSha256,
        signedPacketSha256,
        signature,
      }),
    ),
  });
  signal?.throwIfAborted();
  return {
    format: 'pump-launch-group-signed-evidence-v1' as const,
    reviewId: review.id,
    manifestSha256: review.manifestSha256,
    contextSha256: review.contextSha256,
    packets,
    signedGroupSha256,
    signatureSetVerified: true as const,
    ownershipVerificationRequired: true as const,
    lifetimeValidationRequired: true as const,
    approvalVerificationRequired: true as const,
    runtimeQualificationRequired: true as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    completeLaunch: false as const,
  };
}
