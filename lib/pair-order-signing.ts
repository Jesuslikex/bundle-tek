import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  address,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type SignatureBytes,
} from '@solana/kit';
import {
  validSolanaSigningKey,
  verifySolanaSignature,
} from './solana-signature';
import {
  requirePairOrderSigningWindow,
  type PairOrderSigningAuthorization,
} from './pair-order-authorization';
import type { PairOrderFirstReview } from './pair-order-first-review';
import type { VaultSession } from './browser-wallet-vault';

/** The exact unsigned packet bound by the server execution reservation. */
export type PairOrderExecutionPacket = {
  authorizationId: string;
  wallet: string;
  packet: string;
  packetSha256: string;
};
export type PairOrderSigningApproval = {
  approved: true;
  authorizationId: string;
  authorizationSha256: string;
  packetSha256: string;
};
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

function decodePacket(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1644 ||
    !BASE64.test(value)
  )
    throw new Error('Invalid stock pair packet.');
  const bytes = getBase64Encoder().encode(value);
  if (
    !bytes.length ||
    bytes.length > 1232 ||
    getBase64Decoder().decode(bytes) !== value
  )
    throw new Error('Invalid stock pair packet.');
  const tx = getTransactionDecoder().decode(bytes);
  return { bytes: Uint8Array.from(bytes), tx };
}

/** Reconstruct and check the exact approved unsigned packet. No RPC, no key access. */
export async function requirePairOrderUnsignedPacket(
  supplied: PairOrderExecutionPacket,
) {
  const execution = structuredClone(supplied);
  if (
    !execution ||
    typeof execution.authorizationId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(execution.authorizationId) ||
    typeof execution.packetSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(execution.packetSha256) ||
    typeof execution.wallet !== 'string' ||
    !validSolanaSigningKey(bs58.decode(execution.wallet))
  )
    throw new Error('Stock pair packet identity differs.');
  const { bytes, tx } = decodePacket(execution.packet);
  const keys = Object.keys(tx.signatures);
  if (
    hex(await crypto.subtle.digest('SHA-256', bytes.buffer)) !==
      execution.packetSha256 ||
    keys.length !== 1 ||
    keys[0] !== execution.wallet ||
    Object.values(tx.signatures).some(
      (s) => s !== null && new Uint8Array(s).some((v) => v !== 0),
    )
  )
    throw new Error('Stock pair packet differs from its approved hash.');
  const unsigned = getTransactionEncoder().encode({
    ...tx,
    signatures: { [execution.wallet]: null },
  });
  if (
    unsigned.length !== bytes.length ||
    unsigned.some((b, i) => b !== bytes[i])
  )
    throw new Error('Stock pair packet encoding differs.');
  return { execution, tx };
}

/**
 * Browser-only signer. Signs only the exact reviewed bytes, only inside the
 * five-second server signing window, only after explicit approval of this
 * authorization. Temporary seed and secret bytes are cleared.
 */
export async function signPairOrderPacket(
  session: VaultSession,
  review: PairOrderFirstReview,
  authorization: PairOrderSigningAuthorization,
  supplied: PairOrderExecutionPacket,
  approval: PairOrderSigningApproval,
  current: () => void,
  now: () => number = Date.now,
) {
  if (
    !approval ||
    approval.approved !== true ||
    approval.authorizationId !== authorization.id ||
    approval.authorizationSha256 !== authorization.sha256 ||
    approval.packetSha256 !== authorization.packetSha256 ||
    supplied?.authorizationId !== authorization.id ||
    supplied?.packetSha256 !== authorization.packetSha256 ||
    supplied?.wallet !== review.wallet
  )
    throw new Error('Explicit approval of this exact stock order is required.');
  current();
  await requirePairOrderSigningWindow(authorization, review, now());
  const { execution, tx } = await requirePairOrderUnsignedPacket(supplied);
  const wallet = session.payload.wallets.find(
    (w) => w.family === 'solana' && w.address === execution.wallet,
  );
  if (!wallet || !/^[0-9a-f]{64}$/.test(wallet.seed))
    throw new Error('Unlock the exact reviewed wallet key.');
  const seed = Uint8Array.from(wallet.seed.match(/../g)!, (b) =>
    parseInt(b, 16),
  );
  const pair = nacl.sign.keyPair.fromSeed(seed);
  let signature: Uint8Array;
  try {
    current();
    if (bs58.encode(pair.publicKey) !== execution.wallet)
      throw new Error('Stock order key identity differs.');
    await requirePairOrderSigningWindow(authorization, review, now());
    signature = nacl.sign.detached(
      Uint8Array.from(tx.messageBytes),
      pair.secretKey,
    );
  } finally {
    seed.fill(0);
    pair.secretKey.fill(0);
  }
  if (
    !verifySolanaSignature(
      Uint8Array.from(tx.messageBytes),
      signature,
      bs58.decode(execution.wallet),
    )
  )
    throw new Error('Stock order signature did not verify.');
  current();
  await requirePairOrderSigningWindow(authorization, review, now());
  const signed = getBase64Decoder().decode(
    getTransactionEncoder().encode({
      ...tx,
      signatures: { [address(execution.wallet)]: signature as SignatureBytes },
    }),
  );
  return { signedPacket: signed, signature: bs58.encode(signature) };
}

/** Server and browser: the signed packet must be the exact approved message with one strict signature. */
export async function verifyPairOrderSignedPacket(
  execution: PairOrderExecutionPacket,
  signedPacket: unknown,
) {
  const { execution: approved, tx: original } =
    await requirePairOrderUnsignedPacket(execution);
  const { tx } = decodePacket(signedPacket);
  const signature = tx.signatures[address(approved.wallet)];
  const unsigned = getTransactionEncoder().encode({
      ...tx,
      signatures: { [approved.wallet]: null },
    }),
    expected = getTransactionEncoder().encode({
      ...original,
      signatures: { [approved.wallet]: null },
    });
  if (
    Object.keys(tx.signatures).length !== 1 ||
    !signature ||
    unsigned.length !== expected.length ||
    unsigned.some((b, i) => b !== expected[i]) ||
    tx.messageBytes.length !== original.messageBytes.length ||
    !verifySolanaSignature(
      Uint8Array.from(tx.messageBytes),
      Uint8Array.from(signature),
      bs58.decode(approved.wallet),
    )
  )
    throw new Error('Signed stock packet differs from the approved packet.');
  return bs58.encode(signature);
}
