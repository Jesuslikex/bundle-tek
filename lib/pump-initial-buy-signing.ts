import {
  address,
  getTransactionDecoder,
  getTransactionEncoder,
  getBase64Decoder,
  type SignatureBytes,
} from '@solana/kit-v1';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  verifySolanaSignature,
  validSolanaSigningKey,
} from './solana-signature';
import {
  decodePumpSigningInput,
  type PumpSigningInput,
} from './pump-launch-signing';
import { buildPumpCreateAndBuyMessage } from './pump-initial-buy-message';
import { pumpDeveloperBuyTarget } from './pump-initial-buy-preparation';
import type { VaultSession } from './browser-wallet-vault';

export type PumpInitialBuySigningReview = {
  id: string;
  projectId: string;
  projectUpdatedAt: string;
  releaseId: string;
  expiresAt: string;
  transaction: string;
  sha256: string;
  input: {
    create: PumpSigningInput;
    tokenAmountRaw: string;
    maximumQuoteCostRaw: string;
    transactionVersion: 1;
  };
  developerSupplyPercent: number;
  feeAndRentLimitRaw: string;
};
export type PumpInitialBuyApproval = {
  approved: true;
  reviewId: string;
  sha256: string;
};
const bytes = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
function packet(value: string) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 5464 ||
    btoa(atob(value)) !== value
  )
    throw new Error('Invalid atomic launch packet.');
  const raw = bytes(value);
  if (raw.length > 4096)
    throw new Error('Atomic launch packet exceeds its reviewed limit.');
  const tx = getTransactionDecoder().decode(raw);
  if (getBase64Decoder().decode(getTransactionEncoder().encode(tx)) !== value)
    throw new Error('Atomic launch packet encoding differs.');
  return tx;
}

/** Reconstruct the complete version-1 packet before exposing it to a signer. */
export async function requirePumpInitialBuySigningReview(
  supplied: PumpInitialBuySigningReview,
  current: () => void = () => {},
) {
  const review = structuredClone(supplied);
  current();
  if (
    !review ||
    typeof review.id !== 'string' ||
    !review.id ||
    !/^[0-9a-f]{64}$/.test(review.sha256) ||
    !Number.isFinite(Date.parse(review.expiresAt)) ||
    Date.parse(review.expiresAt) <= Date.now() ||
    typeof review.feeAndRentLimitRaw !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(review.feeAndRentLimitRaw) ||
    BigInt(review.feeAndRentLimitRaw) > 1000000000n ||
    typeof review.transaction !== 'string' ||
    review.transaction.length > 5464 ||
    !review.input ||
    Object.keys(review.input).sort().join(',') !==
      'create,maximumQuoteCostRaw,tokenAmountRaw,transactionVersion' ||
    review.input.transactionVersion !== 1
  )
    throw new Error(
      'Atomic launch review expired or its allowance/version differs.',
    );
  const create = decodePumpSigningInput(review.input.create);
  for (const key of [create.payer, create.mint])
    if (!validSolanaSigningKey(bs58.decode(key)))
      throw new Error('Atomic launch signing identity differs.');
  const built = await buildPumpCreateAndBuyMessage({ ...review.input, create });
  if (
    built.packetSha256 !== review.sha256 ||
    built.transaction !== review.transaction ||
    pumpDeveloperBuyTarget(
      built.quote.tokenSupplyRaw,
      review.developerSupplyPercent,
    ) !== built.tokenAmountRaw
  )
    throw new Error(
      'Atomic launch packet differs from its reviewed metadata, supply target or quote cap.',
    );
  const tx = packet(review.transaction);
  const keys = Object.keys(tx.signatures);
  if (
    keys.length !== 2 ||
    !keys.includes(create.payer) ||
    !keys.includes(create.mint) ||
    Object.values(tx.signatures).some((signature) => signature !== null)
  )
    throw new Error(
      'Atomic launch review must contain exactly two unsigned identities.',
    );
  current();
  if (Date.parse(review.expiresAt) <= Date.now())
    throw new Error('Atomic launch review expired.');
  return tx;
}

/** Browser-only signing primitive. The durable approval API and UI must supply this exact consent. */
export async function signPumpInitialBuy(
  payerSession: VaultSession,
  mintSession: VaultSession,
  supplied: PumpInitialBuySigningReview,
  approval: PumpInitialBuyApproval,
  current: () => void,
) {
  const review = structuredClone(supplied);
  if (
    !approval ||
    approval.approved !== true ||
    approval.reviewId !== review.id ||
    approval.sha256 !== review.sha256
  )
    throw new Error(
      'Explicit approval of this exact atomic launch is required.',
    );
  const tx = await requirePumpInitialBuySigningReview(review, current);
  const signatures: Record<string, SignatureBytes> = {};
  for (const [session, key] of [
    [payerSession, review.input.create.payer],
    [mintSession, review.input.create.mint],
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
        throw new Error('Atomic launch key identity differs.');
      const signature = nacl.sign.detached(
        Uint8Array.from(tx.messageBytes),
        pair.secretKey,
      );
      if (
        !verifySolanaSignature(
          Uint8Array.from(tx.messageBytes),
          signature,
          pair.publicKey,
        )
      )
        throw new Error('Atomic launch signature did not verify.');
      signatures[address(key)] = signature as SignatureBytes;
    } finally {
      seed.fill(0);
      pair.secretKey.fill(0);
    }
  }
  current();
  if (Date.parse(review.expiresAt) <= Date.now())
    throw new Error('Atomic launch review expired.');
  return {
    transaction: getBase64Decoder().decode(
      getTransactionEncoder().encode({ ...tx, signatures }),
    ),
    signature: bs58.encode(signatures[review.input.create.payer]),
  };
}

/** Verify canonical serialization, the exact reconstructed message and both strict signatures. No RPC. */
export async function verifyPumpInitialBuySignedPacket(
  supplied: PumpInitialBuySigningReview,
  signed: string,
) {
  const review = structuredClone(supplied);
  const original = await requirePumpInitialBuySigningReview(review),
    tx = packet(signed);
  if (
    getBase64Decoder().decode(tx.messageBytes) !==
      getBase64Decoder().decode(original.messageBytes) ||
    Object.keys(tx.signatures).length !== 2
  )
    throw new Error('Signed atomic launch message changed.');
  for (const key of [review.input.create.payer, review.input.create.mint]) {
    const sig = tx.signatures[address(key)];
    if (
      !sig ||
      !verifySolanaSignature(
        Uint8Array.from(tx.messageBytes),
        Uint8Array.from(sig),
        bs58.decode(key),
      )
    )
      throw new Error('Both exact atomic launch signatures are required.');
  }
  return bs58.encode(tx.signatures[address(review.input.create.payer)]!);
}
