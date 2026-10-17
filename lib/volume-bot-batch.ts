import {
  address,
  getBase64Decoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type SignatureBytes,
} from '@solana/kit-v1';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { verifySolanaSignature } from './solana-signature';
import type { VaultSession } from './browser-wallet-vault';

/**
 * One approval batch of Volume Bot trades. Each trade is its own unsigned
 * Jupiter swap signed by one wallet. The batch is approved and signed as a
 * whole, never partially, and each trade is sent at its offset after approval.
 */
export type VolumeBatchTrade = {
  index: number;
  round: number;
  side: 'Buy' | 'Sell';
  wallet: string;
  batchOffsetMs: number;
  inAmountRaw: string;
  minimumOutRaw: string;
  estimatedFeesLamports: string;
  transaction: string;
  packetSha256: string;
  lastValidBlockHeight: string;
};
export type VolumeBatchReview = {
  format: 'volume-bot-batch-review-v1';
  id: string;
  sessionId: string;
  batch: number;
  mint: string;
  decimals: number;
  trades: VolumeBatchTrade[];
  /** Planned sells whose buy did not land, so there is nothing to sell. */
  skipped: number[];
  expiresAt: string;
  sha256: string;
  approvalRequired: true;
  executionAllowed: false;
};
export type VolumeBatchConsent = {
  approved: true;
  reviewId: string;
  sha256: string;
  scope: 'volume-bot-batch';
  acknowledgePriceMovesBetweenTrades: true;
};
export const volumeBatchConsent = (
  review: Pick<VolumeBatchReview, 'id' | 'sha256'>,
): VolumeBatchConsent => ({
  approved: true,
  reviewId: review.id,
  sha256: review.sha256,
  scope: 'volume-bot-batch',
  acknowledgePriceMovesBetweenTrades: true,
});

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
const RAW = /^[1-9]\d{0,19}$/;
const canonical = (review: Omit<VolumeBatchReview, 'sha256'>) =>
  JSON.stringify([
    review.format,
    review.id,
    review.sessionId,
    review.batch,
    review.mint,
    review.decimals,
    review.trades.map((t) => [
      t.index,
      t.round,
      t.side,
      t.wallet,
      t.batchOffsetMs,
      t.inAmountRaw,
      t.minimumOutRaw,
      t.estimatedFeesLamports,
      t.transaction,
      t.packetSha256,
      t.lastValidBlockHeight,
    ]),
    review.skipped,
    review.expiresAt,
  ]);
const decode = (encoded: string) => {
  if (
    typeof encoded !== 'string' ||
    !encoded ||
    encoded.length > 5464 ||
    btoa(atob(encoded)) !== encoded
  )
    throw new Error('Invalid volume trade packet encoding.');
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const tx = getTransactionDecoder().decode(bytes);
  if (
    bytes.length > 1232 ||
    getBase64Decoder().decode(getTransactionEncoder().encode(tx)) !== encoded
  )
    throw new Error(
      'Volume trade packet exceeds its bound or is not canonical.',
    );
  return { tx, bytes };
};

export async function createVolumeBatchReview(
  supplied: Omit<
    VolumeBatchReview,
    'format' | 'sha256' | 'approvalRequired' | 'executionAllowed'
  >,
): Promise<VolumeBatchReview> {
  const draft = {
    ...structuredClone(supplied),
    format: 'volume-bot-batch-review-v1' as const,
    approvalRequired: true as const,
    executionAllowed: false as const,
  };
  const sha256 = hex(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(canonical(draft)),
    ),
  );
  const review = { ...draft, sha256 };
  await requireVolumeBatchReview(review);
  return review;
}

/** Reconstructs the batch: one trade per wallet, ordered offsets, single-signer unsigned packets. */
export async function requireVolumeBatchReview(supplied: VolumeBatchReview) {
  const review = structuredClone(supplied);
  if (
    review?.format !== 'volume-bot-batch-review-v1' ||
    review.approvalRequired !== true ||
    review.executionAllowed !== false ||
    !Array.isArray(review.trades) ||
    !Array.isArray(review.skipped) ||
    review.skipped.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    review.trades.length + review.skipped.length === 0 ||
    review.trades.length + review.skipped.length > 25 ||
    !Number.isSafeInteger(review.decimals) ||
    review.decimals < 0 ||
    review.decimals > 18 ||
    !Number.isFinite(Date.parse(review.expiresAt))
  )
    throw new Error('Volume batch review is incomplete.');
  const sha256 = hex(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(canonical(review)),
    ),
  );
  if (sha256 !== review.sha256)
    throw new Error('Volume batch review changed after it was created.');
  const wallets = new Set<string>();
  let previous = -1;
  const decoded = [];
  for (const trade of review.trades) {
    if (wallets.has(trade.wallet))
      throw new Error('Each wallet may trade once per volume batch.');
    wallets.add(trade.wallet);
    if (
      !Number.isSafeInteger(trade.batchOffsetMs) ||
      trade.batchOffsetMs < previous ||
      trade.batchOffsetMs > 30_000
    )
      throw new Error(
        'Volume batch offsets must be ordered within 30 seconds.',
      );
    previous = trade.batchOffsetMs;
    if (
      !['Buy', 'Sell'].includes(trade.side) ||
      !RAW.test(trade.inAmountRaw) ||
      !RAW.test(trade.minimumOutRaw) ||
      !/^\d{1,20}$/.test(trade.estimatedFeesLamports) ||
      !RAW.test(trade.lastValidBlockHeight)
    )
      throw new Error('Volume trade amounts are incomplete.');
    const { tx, bytes } = decode(trade.transaction);
    if (Object.values(tx.signatures).some((s) => s !== null))
      throw new Error('Volume batch packets must be unsigned for review.');
    if (
      hex(await crypto.subtle.digest('SHA-256', bytes)) !== trade.packetSha256
    )
      throw new Error('Volume batch packet hash differs.');
    const message = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    );
    if (
      message.header.numSignerAccounts !== 1 ||
      String(message.staticAccounts[0]) !== trade.wallet ||
      Object.keys(tx.signatures).join(',') !== trade.wallet
    )
      throw new Error('Volume trades must be signed by their wallet alone.');
    decoded.push({ trade, tx });
  }
  return { review, decoded };
}

export function requireVolumeBatchConsent(
  review: VolumeBatchReview,
  consent: VolumeBatchConsent,
) {
  if (
    !consent ||
    consent.approved !== true ||
    consent.reviewId !== review.id ||
    consent.sha256 !== review.sha256 ||
    consent.scope !== 'volume-bot-batch' ||
    consent.acknowledgePriceMovesBetweenTrades !== true
  )
    throw new Error(
      'Explicit approval of this exact volume batch and its price-movement limits is required.',
    );
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
    throw new Error('Unlock every exact wallet key in this batch once.');
  const seed = Uint8Array.from(matches[0].seed.match(/../g)!, (byte) =>
    parseInt(byte, 16),
  );
  let pair: nacl.SignKeyPair | undefined;
  try {
    pair = nacl.sign.keyPair.fromSeed(seed);
    if (bs58.encode(pair.publicKey) !== key)
      throw new Error('Vault seed does not match its reviewed wallet.');
    return consume(pair);
  } finally {
    seed.fill(0);
    pair?.secretKey.fill(0);
  }
}

/** Browser-local signing of a whole approved batch. Returns every signed trade or throws. No RPC, storage or sending. */
export async function signVolumeBatch(
  session: VaultSession,
  suppliedReview: VolumeBatchReview,
  suppliedConsent: VolumeBatchConsent,
  current: () => void,
) {
  const consent = structuredClone(suppliedConsent);
  const { review, decoded } = await requireVolumeBatchReview(suppliedReview);
  const active = () => {
    current();
    if (Date.parse(review.expiresAt) <= Date.now())
      throw new Error('Volume batch expired before signing completed.');
  };
  active();
  requireVolumeBatchConsent(review, consent);
  // Every key must resolve before the first signature exists.
  for (const { trade } of decoded)
    withWalletKey(session, trade.wallet, () => {});
  const signed: { index: number; transaction: string; signature: string }[] =
    [];
  for (const { trade, tx } of decoded) {
    active();
    const message = Uint8Array.from(tx.messageBytes);
    const signature = withWalletKey(session, trade.wallet, (pair) => {
      const value = nacl.sign.detached(message, pair.secretKey);
      if (!verifySolanaSignature(message, value, pair.publicKey))
        throw new Error('Volume trade signature failed strict verification.');
      return value as SignatureBytes;
    });
    signed.push({
      index: trade.index,
      transaction: getBase64Decoder().decode(
        getTransactionEncoder().encode({
          ...tx,
          signatures: { [address(trade.wallet)]: signature },
        }),
      ),
      signature: bs58.encode(signature),
    });
  }
  active();
  await verifyVolumeBatchSigned(
    review,
    signed.map((s) => s.transaction),
  );
  return { reviewId: review.id, sha256: review.sha256, signed };
}

/** Strict whole-batch verification: identical messages, one valid wallet signature each. */
export async function verifyVolumeBatchSigned(
  supplied: VolumeBatchReview,
  transactions: string[],
) {
  const { decoded } = await requireVolumeBatchReview(supplied);
  if (!Array.isArray(transactions) || transactions.length !== decoded.length)
    throw new Error('Signed volume batch must contain every reviewed trade.');
  return decoded.map(({ trade, tx: original }, n) => {
    const { tx } = decode(transactions[n]);
    const signature = tx.signatures[address(trade.wallet)];
    if (
      getBase64Decoder().decode(tx.messageBytes) !==
        getBase64Decoder().decode(original.messageBytes) ||
      Object.keys(tx.signatures).join(',') !== trade.wallet ||
      !signature ||
      !verifySolanaSignature(
        Uint8Array.from(tx.messageBytes),
        Uint8Array.from(signature),
        bs58.decode(trade.wallet),
      )
    )
      throw new Error('Signed volume trade message or signature differs.');
    return bs58.encode(signature);
  });
}
