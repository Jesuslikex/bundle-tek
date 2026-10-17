import {
  address,
  getTransactionDecoder,
  getTransactionEncoder,
  getBase64Decoder,
  getCompiledTransactionMessageDecoder,
  type SignatureBytes,
} from '@solana/kit-v1';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { verifySolanaSignature } from './solana-signature';
import type { VaultSession } from './browser-wallet-vault';

/**
 * One approval batch of organic holder buys. Every buy is a separate
 * holder-only packet sharing one lifetime; the batch is approved and signed as
 * a whole, never partially, and each buy is then sent at its scheduled offset.
 */
export type PumpOrganicBatchBuy = {
  index: number;
  holder: string;
  batchOffsetMs: number;
  tokenAmountRaw: string;
  maximumQuoteCostRaw: string;
  transaction: string;
  packetSha256: string;
};
export type PumpOrganicBatchReview = {
  format: 'pump-organic-batch-review-v1';
  id: string;
  sequenceId: string;
  batch: number;
  mint: string;
  quoteMint: string;
  buys: PumpOrganicBatchBuy[];
  lastValidBlockHeight: string;
  expiresAt: string;
  sha256: string;
  approvalRequired: true;
  executionAllowed: false;
};
export type PumpOrganicBatchConsent = {
  approved: true;
  reviewId: string;
  sha256: string;
  scope: 'organic-holder-buy-batch';
  acknowledgePriceMovesBetweenBuys: true;
};
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
const canonical = (review: Omit<PumpOrganicBatchReview, 'sha256'>) =>
  JSON.stringify([
    review.format,
    review.id,
    review.sequenceId,
    review.batch,
    review.mint,
    review.quoteMint,
    review.buys.map((b) => [
      b.index,
      b.holder,
      b.batchOffsetMs,
      b.tokenAmountRaw,
      b.maximumQuoteCostRaw,
      b.transaction,
      b.packetSha256,
    ]),
    review.lastValidBlockHeight,
    review.expiresAt,
  ]);
const decode = (encoded: string) => {
  if (
    typeof encoded !== 'string' ||
    !encoded ||
    encoded.length > 5464 ||
    btoa(atob(encoded)) !== encoded
  )
    throw new Error('Invalid organic buy packet encoding.');
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const tx = getTransactionDecoder().decode(bytes);
  if (
    bytes.length > 4096 ||
    getBase64Decoder().decode(getTransactionEncoder().encode(tx)) !== encoded
  )
    throw new Error(
      'Organic buy packet exceeds its bound or is not canonical.',
    );
  return { tx, bytes };
};

export async function createPumpOrganicBatchReview(
  supplied: Omit<
    PumpOrganicBatchReview,
    'format' | 'sha256' | 'approvalRequired' | 'executionAllowed'
  >,
): Promise<PumpOrganicBatchReview> {
  const draft = {
    ...structuredClone(supplied),
    format: 'pump-organic-batch-review-v1' as const,
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
  await requirePumpOrganicBatchReview(review);
  return review;
}

/** Reconstructs the batch: unique holders, ordered offsets, holder-only unsigned packets with one shared lifetime. */
export async function requirePumpOrganicBatchReview(
  supplied: PumpOrganicBatchReview,
) {
  const review = structuredClone(supplied);
  if (
    review.format !== 'pump-organic-batch-review-v1' ||
    review.approvalRequired !== true ||
    review.executionAllowed !== false ||
    !Array.isArray(review.buys) ||
    !review.buys.length ||
    review.buys.length > 200 ||
    !Number.isFinite(Date.parse(review.expiresAt))
  )
    throw new Error('Organic batch review is incomplete.');
  const sha256 = hex(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(canonical(review)),
    ),
  );
  if (sha256 !== review.sha256)
    throw new Error('Organic batch review changed after it was created.');
  const holders = new Set<string>();
  let lifetime: string | undefined,
    previous = -1;
  const decoded = [];
  for (const buy of review.buys) {
    if (holders.has(buy.holder))
      throw new Error('Each holder may appear once per organic batch.');
    holders.add(buy.holder);
    if (
      !Number.isSafeInteger(buy.batchOffsetMs) ||
      buy.batchOffsetMs < previous
    )
      throw new Error('Organic batch offsets must be ordered.');
    previous = buy.batchOffsetMs;
    const { tx, bytes } = decode(buy.transaction);
    if (Object.values(tx.signatures).some((s) => s !== null))
      throw new Error('Organic batch packets must be unsigned for review.');
    if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== buy.packetSha256)
      throw new Error('Organic batch packet hash differs.');
    const message = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    );
    if (
      message.header.numSignerAccounts !== 1 ||
      String(message.staticAccounts[0]) !== buy.holder ||
      Object.keys(tx.signatures).join(',') !== buy.holder
    )
      throw new Error(
        'Organic batch buys must be signed by their holder alone.',
      );
    const token = String(message.lifetimeToken);
    if (lifetime !== undefined && token !== lifetime)
      throw new Error('Every buy in one organic batch shares one lifetime.');
    lifetime = token;
    decoded.push({ buy, tx });
  }
  return { review, decoded };
}

export function requirePumpOrganicBatchConsent(
  review: PumpOrganicBatchReview,
  consent: PumpOrganicBatchConsent,
) {
  if (
    !consent ||
    consent.approved !== true ||
    consent.reviewId !== review.id ||
    consent.sha256 !== review.sha256 ||
    consent.scope !== 'organic-holder-buy-batch' ||
    consent.acknowledgePriceMovesBetweenBuys !== true
  )
    throw new Error(
      'Explicit approval of this exact organic batch and its price-movement limits is required.',
    );
}

function withHolderKey<T>(
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
    throw new Error('Unlock every exact holder key in this batch once.');
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

/** Browser-local signing of a whole approved batch. Returns all signed buys or none. No RPC, storage or sending. */
export async function signPumpOrganicBatch(
  suppliedSessions: ReadonlyMap<string, VaultSession>,
  suppliedReview: PumpOrganicBatchReview,
  suppliedConsent: PumpOrganicBatchConsent,
  current: () => void,
) {
  const consent = structuredClone(suppliedConsent),
    sessions = new Map(suppliedSessions);
  const { review, decoded } =
    await requirePumpOrganicBatchReview(suppliedReview);
  const active = () => {
    current();
    if (Date.parse(review.expiresAt) <= Date.now())
      throw new Error('Organic batch expired before signing completed.');
  };
  active();
  requirePumpOrganicBatchConsent(review, consent);
  if (
    sessions.size !== decoded.length ||
    decoded.some(({ buy }) => !sessions.has(buy.holder))
  )
    throw new Error('Unlock exactly the holder wallets in this batch.');
  for (const { buy } of decoded) {
    active();
    withHolderKey(sessions.get(buy.holder)!, buy.holder, () => {});
  }
  const signed: {
    index: number;
    holder: string;
    transaction: string;
    signature: string;
  }[] = [];
  for (const { buy, tx } of decoded) {
    active();
    const message = Uint8Array.from(tx.messageBytes);
    const signature = withHolderKey(
      sessions.get(buy.holder)!,
      buy.holder,
      (pair) => {
        const value = nacl.sign.detached(message, pair.secretKey);
        if (!verifySolanaSignature(message, value, pair.publicKey))
          throw new Error('Organic buy signature failed strict verification.');
        return value as SignatureBytes;
      },
    );
    signed.push({
      index: buy.index,
      holder: buy.holder,
      transaction: getBase64Decoder().decode(
        getTransactionEncoder().encode({
          ...tx,
          signatures: { [address(buy.holder)]: signature },
        }),
      ),
      signature: bs58.encode(signature),
    });
  }
  active();
  await verifyPumpOrganicBatchSigned(
    review,
    signed.map((s) => s.transaction),
  );
  return { reviewId: review.id, sha256: review.sha256, signed };
}

/** Strict whole-batch verification: same messages, one valid holder signature each. */
export async function verifyPumpOrganicBatchSigned(
  supplied: PumpOrganicBatchReview,
  transactions: string[],
) {
  const { decoded } = await requirePumpOrganicBatchReview(supplied);
  if (!Array.isArray(transactions) || transactions.length !== decoded.length)
    throw new Error('Signed organic batch must contain every reviewed buy.');
  return decoded.map(({ buy, tx: original }, n) => {
    const { tx } = decode(transactions[n]);
    const signature = tx.signatures[address(buy.holder)];
    if (
      getBase64Decoder().decode(tx.messageBytes) !==
        getBase64Decoder().decode(original.messageBytes) ||
      Object.keys(tx.signatures).join(',') !== buy.holder ||
      !signature ||
      !verifySolanaSignature(
        Uint8Array.from(tx.messageBytes),
        Uint8Array.from(signature),
        bs58.decode(buy.holder),
      )
    )
      throw new Error(
        'Signed organic buy message or holder signature differs.',
      );
    return bs58.encode(signature);
  });
}
