import { ed25519 } from '@noble/curves/ed25519';

/** Wallet identities and signature commitments must be canonical nonzero prime-order points. */
export function validSolanaSigningKey(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return false;
  try {
    const point = ed25519.Point.fromBytes(bytes, false);
    return (
      !point.isSmallOrder() &&
      point.isTorsionFree() &&
      point.toBytes().every((byte, index) => byte === bytes[index])
    );
  } catch {
    return false;
  }
}

/** Strict message authentication, not permissive consensus verification. */
export function verifySolanaSignature(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
) {
  if (
    !(message instanceof Uint8Array) ||
    !(signature instanceof Uint8Array) ||
    signature.length !== 64 ||
    !validSolanaSigningKey(publicKey) ||
    !validSolanaSigningKey(signature.subarray(0, 32))
  )
    return false;
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}
