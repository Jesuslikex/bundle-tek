import {
  address,
  getTransactionDecoder,
  getTransactionEncoder,
  getBase64Decoder,
  type SignatureBytes,
} from '@solana/kit-v1';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { verifySolanaSignature } from './solana-signature';
import {
  requirePumpHolderReview,
  type PumpHolderReview,
} from './pump-holder-review';
import type { VaultSession } from './browser-wallet-vault';

export type PumpHolderConsent = {
  approved: true;
  reviewId: string;
  sha256: string;
  contextSha256: string;
  approvedScope: 'create-developer-and-holder-buys';
  acknowledgeSimulationLimits: true;
};
export function requirePumpHolderConsent(
  review: PumpHolderReview,
  consent: PumpHolderConsent,
) {
  if (
    !consent ||
    consent.approved !== true ||
    consent.reviewId !== review.id ||
    consent.sha256 !== review.sha256 ||
    consent.contextSha256 !== review.contextSha256 ||
    consent.approvedScope !== 'create-developer-and-holder-buys' ||
    consent.acknowledgeSimulationLimits !== true
  )
    throw new Error(
      'Explicit approval of this complete holder packet, context and simulation limits is required.',
    );
}
function decodePacket(encoded: string) {
  if (
    typeof encoded !== 'string' ||
    !encoded ||
    encoded.length > 5464 ||
    btoa(atob(encoded)) !== encoded
  )
    throw new Error('Invalid holder signed packet encoding.');
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
    tx = getTransactionDecoder().decode(bytes);
  if (
    bytes.length > 4096 ||
    getBase64Decoder().decode(getTransactionEncoder().encode(tx)) !== encoded
  )
    throw new Error(
      'Holder signed packet exceeds its bound or is not canonical.',
    );
  return tx;
}
function withWalletKey<T>(
  session: VaultSession,
  key: string,
  consume: (pair: nacl.SignKeyPair) => T,
) {
  const matches = Array.isArray(session?.payload?.wallets)
    ? session.payload.wallets.filter(
        (w) => w.family === 'solana' && w.address === key,
      )
    : [];
  if (matches.length !== 1 || !/^[a-f0-9]{64}$/.test(matches[0].seed))
    throw new Error('Unlock every exact holder, deployer and mint key once.');
  const seed = Uint8Array.from(matches[0].seed.match(/../g)!, (byte) =>
    parseInt(byte, 16),
  );
  let pair: nacl.SignKeyPair | undefined;
  try {
    pair = nacl.sign.keyPair.fromSeed(seed);
    if (bs58.encode(pair.publicKey) !== key)
      throw new Error('Holder vault seed does not match its reviewed address.');
    return consume(pair);
  } finally {
    seed.fill(0);
    pair?.secretKey.fill(0);
  }
}

/** Browser-local all-wallet signing only. Caller must obtain durable approval and provide a live UI-context guard. No RPC/storage. */
export async function signPumpHolderPacket(
  suppliedSessions: ReadonlyMap<string, VaultSession>,
  suppliedReview: PumpHolderReview,
  suppliedConsent: PumpHolderConsent,
  current: () => void,
) {
  const review = structuredClone(suppliedReview),
    consent = structuredClone(suppliedConsent),
    sessions = new Map(suppliedSessions);
  const active = () => {
    current();
    if (Date.parse(review.expiresAt) <= Date.now())
      throw new Error('Holder review expired before signing completed.');
  };
  active();
  requirePumpHolderConsent(review, consent);
  const { transaction: original, built } =
    await requirePumpHolderReview(review);
  active();
  if (
    sessions.size !== built.requiredSigners.length ||
    built.requiredSigners.some((key) => !sessions.has(key))
  )
    throw new Error(
      'Unlock exactly the complete required signer set; inactive holders do not sign.',
    );
  // Check every identity before generating even the first signature. Never return a partial packet.
  for (const key of built.requiredSigners) {
    active();
    withWalletKey(sessions.get(key)!, key, () => {});
  }
  const signatures = { ...original.signatures };
  for (const key of built.requiredSigners) {
    active();
    signatures[address(key)] = withWalletKey(
      sessions.get(key)!,
      key,
      (pair) => {
        const signature = nacl.sign.detached(
          Uint8Array.from(original.messageBytes),
          pair.secretKey,
        );
        if (
          !verifySolanaSignature(
            Uint8Array.from(original.messageBytes),
            signature,
            pair.publicKey,
          )
        )
          throw new Error('Holder signature failed strict verification.');
        return signature as SignatureBytes;
      },
    );
  }
  active();
  const transaction = getBase64Decoder().decode(
    getTransactionEncoder().encode({ ...original, signatures }),
  );
  const signature = await verifyPumpHolderSignedPacket(review, transaction);
  active();
  return {
    transaction,
    signature,
    reviewId: review.id,
    sha256: review.sha256,
    contextSha256: review.contextSha256,
  };
}

/** Strict verification also accepts expired saved reviews for registration/receipt recovery. Never signs or sends. */
export async function verifyPumpHolderSignedPacket(
  supplied: PumpHolderReview,
  encoded: string,
) {
  const review = structuredClone(supplied),
    { transaction: original, built } = await requirePumpHolderReview(
      review,
      false,
    ),
    tx = decodePacket(encoded);
  if (
    getBase64Decoder().decode(tx.messageBytes) !==
      getBase64Decoder().decode(original.messageBytes) ||
    JSON.stringify(Object.keys(tx.signatures).sort()) !==
      JSON.stringify([...built.requiredSigners].sort())
  )
    throw new Error('Signed holder packet message or signer set changed.');
  for (const key of built.requiredSigners) {
    const signature = tx.signatures[address(key)];
    if (
      !signature ||
      !verifySolanaSignature(
        Uint8Array.from(tx.messageBytes),
        Uint8Array.from(signature),
        bs58.decode(key),
      )
    )
      throw new Error(
        'Every exact holder, deployer and mint signature is required.',
      );
  }
  return bs58.encode(tx.signatures[address(review.input.create.payer)]!);
}
